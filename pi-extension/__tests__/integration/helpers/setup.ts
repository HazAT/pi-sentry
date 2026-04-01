import { resolve } from "node:path";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  type FauxResponseStep,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  type AgentSession,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { createEnvelopeServer, type EnvelopeServer } from "./envelope-server.ts";

const EXTENSION_PATH = resolve(import.meta.dirname, "../../../index.ts");

export interface TestSessionContext {
  session: AgentSession;
  server: EnvelopeServer;
  faux: FauxProviderRegistration;
  cleanup(): Promise<void>;
}

export interface TestSessionOptions {
  /** Set to null to disable DSN (no monitoring). Default: auto from mock server. */
  dsn?: string | null;
  /** Opt in to request/tool input capture for tests that need it. */
  recordInputs?: boolean;
  /** Opt in to request/tool output capture for tests that need it. */
  recordOutputs?: boolean;
  /** Canned responses for the faux model. Default: single "Hello!" text response. */
  responses?: FauxResponseStep[];
  /** Additional extension file paths to load alongside the Sentry extension. */
  additionalExtensionPaths?: string[];
  /** Inline extension factories to load alongside the Sentry extension. */
  extensionFactories?: ExtensionFactory[];
  /** Whether to load the Sentry extension. Default: true. */
  loadSentryExtension?: boolean;
}

export async function createTestSession(
  options: TestSessionOptions = {},
): Promise<TestSessionContext> {
  const {
    responses = [fauxAssistantMessage("Hello!")],
    additionalExtensionPaths = [],
    extensionFactories = [],
    loadSentryExtension = true,
  } = options;

  // Start envelope server
  const server = await createEnvelopeServer();

  // Save env state
  const prevDsn = process.env.PI_SENTRY_DSN;
  const prevSentryDsn = process.env.SENTRY_DSN;
  const prevRecordInputs = process.env.PI_SENTRY_RECORD_INPUTS;
  const prevRecordOutputs = process.env.PI_SENTRY_RECORD_OUTPUTS;

  // Configure DSN
  const dsn = options.dsn === undefined ? server.dsn : options.dsn;
  if (dsn) {
    process.env.PI_SENTRY_DSN = dsn;
  } else {
    delete process.env.PI_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
  }

  if (options.recordInputs !== undefined) {
    process.env.PI_SENTRY_RECORD_INPUTS = String(options.recordInputs);
  }

  if (options.recordOutputs !== undefined) {
    process.env.PI_SENTRY_RECORD_OUTPUTS = String(options.recordOutputs);
  }

  // Register faux provider
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const model = faux.getModel();

  // Set up auth with a fake key so model validation passes
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("faux", "fake-key");
  const modelRegistry = ModelRegistry.create(authStorage);

  // Build extension paths
  const extensionPaths = [...additionalExtensionPaths];
  if (loadSentryExtension) {
    extensionPaths.unshift(EXTENSION_PATH);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    extensionFactories,
    // No skill/prompt/theme discovery for tests
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => "You are a test assistant. Be brief.",
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  let cleaned = false;

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;

    session.dispose();
    faux.unregister();
    await server.close();

    // Restore env
    if (prevDsn !== undefined) {
      process.env.PI_SENTRY_DSN = prevDsn;
    } else {
      delete process.env.PI_SENTRY_DSN;
    }
    if (prevSentryDsn !== undefined) {
      process.env.SENTRY_DSN = prevSentryDsn;
    } else {
      delete process.env.SENTRY_DSN;
    }
    if (prevRecordInputs !== undefined) {
      process.env.PI_SENTRY_RECORD_INPUTS = prevRecordInputs;
    } else {
      delete process.env.PI_SENTRY_RECORD_INPUTS;
    }
    if (prevRecordOutputs !== undefined) {
      process.env.PI_SENTRY_RECORD_OUTPUTS = prevRecordOutputs;
    } else {
      delete process.env.PI_SENTRY_RECORD_OUTPUTS;
    }
  }

  return { session, server, faux, cleanup };
}

export async function withTestSession<T>(
  options: TestSessionOptions,
  run: (ctx: TestSessionContext) => Promise<T>,
): Promise<T> {
  const ctx = await createTestSession(options);
  try {
    return await run(ctx);
  } finally {
    await ctx.cleanup();
  }
}
