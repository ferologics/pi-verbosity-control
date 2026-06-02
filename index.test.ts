import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildFooterRightSideCandidates,
    cycleVerbosity,
    getExactModelKey,
    injectVerbosityIntoFooterLine,
    loadConfig,
    patchPayloadVerbosity,
    resolveConfiguredVerbosity,
    saveConfig,
    type VerbosityConfig,
} from "./index.js";

const originalHome = process.env.HOME;
let testHome = "";

beforeAll(async () => {
    testHome = await mkdtemp(path.join(os.tmpdir(), "pi-verbosity-control-test-"));
    process.env.HOME = testHome;
});

beforeEach(async () => {
    await rm(path.join(testHome, ".pi"), { recursive: true, force: true });
});

afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });

    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
});

function createModel(overrides?: Partial<Model<Api>>): Model<Api> {
    return {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 272000,
        maxTokens: 128000,
        ...overrides,
    };
}

describe("pi-verbosity-control helpers", () => {
    it("cycles verbosity in a loop", () => {
        expect(cycleVerbosity(undefined)).toBe("low");
        expect(cycleVerbosity("low")).toBe("medium");
        expect(cycleVerbosity("medium")).toBe("high");
        expect(cycleVerbosity("high")).toBe("low");
    });

    it("prefers exact provider/model matches over bare model ids", () => {
        const model = createModel();
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
                "openai-codex/gpt-5.4": "high",
            },
        };

        expect(resolveConfiguredVerbosity(config, model)).toEqual({
            key: "openai-codex/gpt-5.4",
            verbosity: "high",
        });
    });

    it("patches payload text verbosity without dropping existing text fields", () => {
        const payload = {
            model: "gpt-5.4",
            text: {
                format: "plain",
            },
        };

        expect(patchPayloadVerbosity(payload, "low")).toEqual({
            model: "gpt-5.4",
            text: {
                format: "plain",
                verbosity: "low",
            },
        });
    });

    it("builds footer candidates with and without provider prefix", () => {
        expect(buildFooterRightSideCandidates(createModel(), "xhigh")).toEqual([
            "(openai-codex) gpt-5.4 • xhigh",
            "gpt-5.4 • xhigh",
        ]);
    });

    it("injects verbosity into the footer line by consuming padding", () => {
        const line = "↑1.2k ↓3.4k          (openai-codex) gpt-5.4 • xhigh";

        expect(injectVerbosityIntoFooterLine(line, createModel(), "xhigh", "low")).toBe(
            "↑1.2k ↓3.4k (openai-codex) gpt-5.4 • xhigh • 🗣  low",
        );
    });

    it("keeps the footer width stable when space is tight", () => {
        const line = "stats  gpt-5.4 • xhigh";
        const nextLine = injectVerbosityIntoFooterLine(line, createModel(), "xhigh", "low");

        expect(visibleWidth(nextLine)).toBe(visibleWidth(line));
        expect(nextLine).toContain("gpt-5.4 • xhigh •");
    });
});

describe("pi-verbosity-control config io", () => {
    it("loads missing config as empty with hidden indicator", async () => {
        await expect(loadConfig()).resolves.toEqual({ showIndicator: false, models: {} });
    });

    it("saves config with pretty JSON", async () => {
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        };

        await saveConfig(config);

        const raw = await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8");
        expect(raw).toBe(`{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low"
    }
}\n`);
    });

    it("ignores invalid config values and keeps valid ones", async () => {
        const configPath = path.join(testHome, ".pi", "agent", "verbosity.json");
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            `${JSON.stringify(
                {
                    showIndicator: true,
                    models: {
                        "gpt-5.4": "LOW",
                        "openai-codex/gpt-5.4": "banana",
                        "": "medium",
                    },
                },
                null,
                4,
            )}\n`,
            "utf8",
        );

        await expect(loadConfig()).resolves.toEqual({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
    });

    it("builds the expected exact model key", () => {
        expect(getExactModelKey(createModel())).toBe("openai-codex/gpt-5.4");
    });
});

async function createRuntime(config: VerbosityConfig) {
    await saveConfig(config);

    const { default: verbosityControlExtension } = await import("./index.js");

    let sessionStartHandler: ((event: unknown, ctx: TestContext) => Promise<void> | void) | undefined;
    let sessionShutdownHandler: ((event: unknown, ctx: TestContext) => Promise<void> | void) | undefined;
    let beforeProviderRequestHandler: ((event: { payload: unknown }, ctx: TestContext) => unknown) | undefined;
    const shortcutHandlers = new Map<string, (ctx: TestContext) => Promise<void> | void>();

    const pi = {
        on: (event: string, handler: (event: unknown, ctx: TestContext) => Promise<void> | void) => {
            if (event === "session_start") {
                sessionStartHandler = handler;
            }
            if (event === "session_shutdown") {
                sessionShutdownHandler = handler;
            }
            if (event === "before_provider_request") {
                beforeProviderRequestHandler = handler as (event: { payload: unknown }, ctx: TestContext) => unknown;
            }
        },
        registerShortcut: (shortcut: string, options: { handler: (ctx: TestContext) => Promise<void> | void }) => {
            shortcutHandlers.set(shortcut, options.handler);
        },
    };

    verbosityControlExtension(pi as never);

    const cycleShortcut = process.platform === "darwin" ? "alt+v" : "ctrl+alt+v";
    const toggleIndicatorShortcut = process.platform === "darwin" ? "alt+shift+v" : "ctrl+alt+shift+v";
    const cycleShortcutHandler = shortcutHandlers.get(cycleShortcut);
    const toggleIndicatorShortcutHandler = shortcutHandlers.get(toggleIndicatorShortcut);

    if (
        !sessionStartHandler ||
        !sessionShutdownHandler ||
        !beforeProviderRequestHandler ||
        !cycleShortcutHandler ||
        !toggleIndicatorShortcutHandler
    ) {
        throw new Error("Extension did not register expected handlers");
    }

    return {
        sessionStartHandler,
        sessionShutdownHandler,
        beforeProviderRequestHandler,
        cycleShortcutHandler,
        toggleIndicatorShortcutHandler,
    };
}

type TestContext = {
    hasUI: boolean;
    model: Model<Api> | undefined;
    ui: {
        notify: (message: string, level?: string) => void;
    };
};

function createContext(model: Model<Api>): {
    ctx: TestContext;
    notifyMock: ReturnType<typeof vi.fn>;
} {
    const notifyMock = vi.fn();

    return {
        ctx: {
            hasUI: true,
            model,
            ui: {
                notify: notifyMock,
            },
        },
        notifyMock,
    };
}

describe("pi-verbosity-control runtime", () => {
    it("patches requests for configured models after session start", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx } = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);

        const patched = runtime.beforeProviderRequestHandler(
            {
                payload: {
                    model: "gpt-5.4",
                    stream: true,
                },
            },
            ctx,
        );

        expect(patched).toEqual({
            model: "gpt-5.4",
            stream: true,
            text: {
                verbosity: "low",
            },
        });

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("cycles and persists the current model setting from the shortcut", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx, notifyMock } = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.cycleShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        expect(saved.showIndicator).toBe(false);
        expect(saved.models["gpt-5.4"]).toBe("medium");
        expect(notifyMock).toHaveBeenLastCalledWith("Verbosity for gpt-5.4 → medium", "info");

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("toggles indicator visibility and persists it", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx, notifyMock } = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.toggleIndicatorShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        expect(saved.showIndicator).toBe(true);
        expect(saved.models["gpt-5.4"]).toBe("low");
        expect(notifyMock).toHaveBeenLastCalledWith("Verbosity indicator shown.", "info");

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("patches only while the indicator is enabled and cleans up on session shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx } = createContext(createModel());
        const originalRender = FooterComponent.prototype.render;

        await runtime.sessionStartHandler({}, ctx);
        expect(FooterComponent.prototype.render).not.toBe(originalRender);

        await runtime.sessionShutdownHandler({}, ctx);
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });
});
