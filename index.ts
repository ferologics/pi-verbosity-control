import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, FooterComponent } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Verbosity = "low" | "medium" | "high";

export type VerbosityConfig = {
    showIndicator: boolean;
    models: Record<string, Verbosity>;
};

type JsonObject = Record<string, unknown>;

type SupportedVerbosityApi = "openai-responses" | "openai-codex-responses" | "azure-openai-responses";

const DEFAULT_CONFIG: VerbosityConfig = {
    showIndicator: false,
    models: {},
};

const MACOS_CYCLE_SHORTCUT = "alt+v";
const OTHER_CYCLE_SHORTCUT = "ctrl+alt+v";
const MACOS_TOGGLE_INDICATOR_SHORTCUT = "alt+shift+v";
const OTHER_TOGGLE_INDICATOR_SHORTCUT = "ctrl+alt+shift+v";
const SUPPORTED_APIS = new Set<SupportedVerbosityApi>([
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
]);

let originalFooterRender: ((this: FooterComponent, width: number) => string[]) | undefined;
let footerPatched = false;

function createDefaultConfig(): VerbosityConfig {
    return {
        showIndicator: DEFAULT_CONFIG.showIndicator,
        models: {},
    };
}

export function getGlobalConfigPath(): string {
    return path.join(os.homedir(), ".pi", "agent", "verbosity.json");
}

export function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeVerbosity(value: unknown): Verbosity | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "low" || normalized === "medium" || normalized === "high") {
        return normalized;
    }

    return undefined;
}

export function parseConfig(value: unknown): VerbosityConfig {
    if (!isObject(value)) {
        return createDefaultConfig();
    }

    const parsedModels = isObject(value.models) ? value.models : {};
    const models: Record<string, Verbosity> = {};

    for (const [rawKey, rawValue] of Object.entries(parsedModels)) {
        const key = rawKey.trim();
        const verbosity = normalizeVerbosity(rawValue);
        if (!key || !verbosity) {
            continue;
        }

        models[key] = verbosity;
    }

    return {
        showIndicator: typeof value.showIndicator === "boolean" ? value.showIndicator : DEFAULT_CONFIG.showIndicator,
        models,
    };
}

export async function loadConfig(configPath = getGlobalConfigPath()): Promise<VerbosityConfig> {
    try {
        const raw = await readFile(configPath, "utf8");
        return parseConfig(JSON.parse(raw) as unknown);
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") {
            return createDefaultConfig();
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-verbosity-control] Failed to read ${configPath}: ${message}`);
        return createDefaultConfig();
    }
}

export async function saveConfig(config: VerbosityConfig, configPath = getGlobalConfigPath()): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, "utf8");
}

export function getExactModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
}

export function supportsVerbosityControl(model: Pick<Model<Api>, "api"> | undefined): boolean {
    if (!model) {
        return false;
    }

    return SUPPORTED_APIS.has(model.api as SupportedVerbosityApi);
}

export function resolveConfiguredVerbosity(
    config: VerbosityConfig,
    model: Pick<Model<Api>, "provider" | "id">,
): { key?: string; verbosity?: Verbosity } {
    const exactKey = getExactModelKey(model);
    const exactVerbosity = config.models[exactKey];
    if (exactVerbosity) {
        return { key: exactKey, verbosity: exactVerbosity };
    }

    const sharedVerbosity = config.models[model.id];
    if (sharedVerbosity) {
        return { key: model.id, verbosity: sharedVerbosity };
    }

    return {};
}

export function cycleVerbosity(current: Verbosity | undefined): Verbosity {
    switch (current) {
        case "low":
            return "medium";
        case "medium":
            return "high";
        case "high":
            return "low";
        default:
            return "low";
    }
}

export function setModelVerbosity(config: VerbosityConfig, key: string, verbosity: Verbosity): VerbosityConfig {
    return {
        showIndicator: config.showIndicator,
        models: {
            ...config.models,
            [key]: verbosity,
        },
    };
}

export function setIndicatorVisibility(config: VerbosityConfig, showIndicator: boolean): VerbosityConfig {
    return {
        showIndicator,
        models: { ...config.models },
    };
}

export function patchPayloadVerbosity(payload: unknown, verbosity: Verbosity): unknown {
    if (!isObject(payload)) {
        return payload;
    }

    const text = isObject(payload.text) ? payload.text : {};

    return {
        ...payload,
        text: {
            ...text,
            verbosity,
        },
    };
}

export function buildFooterRightSideCandidates(
    model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
    thinkingLevel: string | undefined,
): string[] {
    const modelName = model.id;
    let rightSideWithoutProvider = modelName;

    if (model.reasoning) {
        const level = thinkingLevel || "off";
        rightSideWithoutProvider = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
    }

    return [`(${model.provider}) ${rightSideWithoutProvider}`, rightSideWithoutProvider];
}

export function injectVerbosityIntoFooterLine(
    line: string,
    model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
    thinkingLevel: string | undefined,
    verbosity: Verbosity,
): string {
    const candidates = buildFooterRightSideCandidates(model, thinkingLevel);
    const suffix = ` • 🗣  ${verbosity}`;

    for (const candidate of candidates) {
        const candidateStart = line.lastIndexOf(candidate);
        if (candidateStart === -1) {
            continue;
        }

        let paddingStart = candidateStart;
        while (paddingStart > 0 && line[paddingStart - 1] === " ") {
            paddingStart--;
        }

        const prefix = line.slice(0, paddingStart);
        const suffixAnsi = line.slice(candidateStart + candidate.length);
        const availableWidth = candidateStart - paddingStart + visibleWidth(candidate);
        const desiredRightSide = `${candidate}${suffix}`;
        const fittedRightSide = truncateToWidth(desiredRightSide, availableWidth, "");
        const fittedWidth = visibleWidth(fittedRightSide);
        const nextPadding = " ".repeat(Math.max(0, availableWidth - fittedWidth));

        return `${prefix}${nextPadding}${fittedRightSide}${suffixAnsi}`;
    }

    return line;
}

function patchFooterRender(getConfig: () => VerbosityConfig): void {
    if (footerPatched) {
        return;
    }

    originalFooterRender = FooterComponent.prototype.render;
    FooterComponent.prototype.render = function renderWithVerbosity(width: number): string[] {
        const lines = originalFooterRender?.call(this, width) ?? [];
        if (lines.length < 2) {
            return lines;
        }

        const session = (this as unknown as { session?: { state?: { model?: Model<Api>; thinkingLevel?: string } } })
            .session;
        const model = session?.state?.model;
        if (!model || !supportsVerbosityControl(model)) {
            return lines;
        }

        const { verbosity } = resolveConfiguredVerbosity(getConfig(), model);
        if (!verbosity) {
            return lines;
        }

        const nextLines = [...lines];
        nextLines[1] = injectVerbosityIntoFooterLine(lines[1] ?? "", model, session?.state?.thinkingLevel, verbosity);
        return nextLines;
    };
    footerPatched = true;
}

function unpatchFooterRender(): void {
    if (!footerPatched || !originalFooterRender) {
        return;
    }

    FooterComponent.prototype.render = originalFooterRender;
    footerPatched = false;
    originalFooterRender = undefined;
}

function getCycleShortcut(): KeyId {
    return process.platform === "darwin" ? (MACOS_CYCLE_SHORTCUT as KeyId) : (OTHER_CYCLE_SHORTCUT as KeyId);
}

function getToggleIndicatorShortcut(): KeyId {
    return process.platform === "darwin"
        ? (MACOS_TOGGLE_INDICATOR_SHORTCUT as KeyId)
        : (OTHER_TOGGLE_INDICATOR_SHORTCUT as KeyId);
}

export default function piVerbosityControlExtension(pi: ExtensionAPI): void {
    let activeConfig = createDefaultConfig();

    const syncFooterIndicator = () => {
        if (activeConfig.showIndicator) {
            patchFooterRender(() => activeConfig);
            return;
        }

        unpatchFooterRender();
    };

    pi.registerShortcut(getCycleShortcut(), {
        description: "Cycle response verbosity for the current model",
        handler: async (ctx) => {
            const model = ctx.model;
            if (!model) {
                if (ctx.hasUI) {
                    ctx.ui.notify("No active model.", "warning");
                }
                return;
            }

            if (!supportsVerbosityControl(model)) {
                if (ctx.hasUI) {
                    ctx.ui.notify(`Verbosity control is not supported for ${model.provider}/${model.id}.`, "warning");
                }
                return;
            }

            const resolved = resolveConfiguredVerbosity(activeConfig, model);
            const nextVerbosity = cycleVerbosity(resolved.verbosity);
            const configKey = resolved.key ?? getExactModelKey(model);
            const nextConfig = setModelVerbosity(activeConfig, configKey, nextVerbosity);

            try {
                await saveConfig(nextConfig);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Failed to save verbosity config: ${message}`, "error");
                }
                return;
            }

            activeConfig = nextConfig;

            if (ctx.hasUI) {
                ctx.ui.notify(`Verbosity for ${configKey} → ${nextVerbosity}`, "info");
            }
        },
    });

    pi.registerShortcut(getToggleIndicatorShortcut(), {
        description: "Toggle verbosity indicator visibility",
        handler: async (ctx) => {
            const nextConfig = setIndicatorVisibility(activeConfig, !activeConfig.showIndicator);

            try {
                await saveConfig(nextConfig);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Failed to save verbosity config: ${message}`, "error");
                }
                return;
            }

            activeConfig = nextConfig;
            syncFooterIndicator();

            if (ctx.hasUI) {
                ctx.ui.notify(`Verbosity indicator ${activeConfig.showIndicator ? "shown" : "hidden"}.`, "info");
            }
        },
    });

    pi.on("session_start", async () => {
        activeConfig = await loadConfig();
        syncFooterIndicator();
    });

    pi.on("session_shutdown", async () => {
        unpatchFooterRender();
    });

    pi.on("before_provider_request", (event, ctx) => {
        const model = ctx.model;
        if (!model || !supportsVerbosityControl(model)) {
            return undefined;
        }

        const { verbosity } = resolveConfiguredVerbosity(activeConfig, model);
        if (!verbosity) {
            return undefined;
        }

        return patchPayloadVerbosity(event.payload, verbosity);
    });
}
