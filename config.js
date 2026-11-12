/**
 * NovaOS Enterprise v5.0 — Application & AI Configuration (`config.js`)
 *
 * HARDCODED SINGLE SOURCE OF TRUTH FOR API & MODEL SETTINGS:
 * Edit your API key, endpoint, and default models strictly inside this file.
 * The web interface displays these settings as read-only telemetry so credentials
 * cannot be overwritten from browser UI inputs.
 */
window.APP_CONFIG = {
  // Configured API Key (Set here for local browser mode, or move to .dev.vars when using server/proxy.js)
  apiKey: "AQ.Ab8RN6JDGOy_U0MMStWlfEJ3yOEFXPO1Zjo3S0UHpn1RZnpyQA",

  // Gemini OpenAI-Compatible Endpoint (or set to "/api/chat" when running behind server/proxy.js)
  apiEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",

  // Active Text-Out Model (From your active quota table: gemini-2.5-flash, gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.8-flash, gemma-4-31b)
  model: "gemini-2.5-flash",

  // Secondary Model for Real Parallel Multi-Model Arena Comparison
  compareModel: "gemini-3.1-flash-lite",

  // Embedding Model for Semantic RAG 2.0 (gemini-embedding-2: 100 RPM / 30K TPM / 1K RPD)
  embeddingModel: "gemini-embedding-2",

  // Default Enterprise Persona & System Instructions
  defaultSystemPrompt: "You are NovaOS Neural Core, an enterprise business intelligence assistant and autonomous workspace orchestrator. You analyze customer operations, query and manage business records using structured function tools, search uploaded company documents with citations, and deliver clear executive insights.",

  // Persona Display Title
  personaName: "NovaOS Neural Core",

  // Sampling Temperature (0.0 = deterministic, 1.0 = creative)
  temperature: 0.4,

  // Maximum Output Tokens
  maxTokens: 1536,

  // Conversational Context Window Turns
  contextWindowSize: 12,

  // Default Theme ('light' for Enterprise Business Default)
  defaultTheme: "light",

  // Lock API & Firebase Configuration strictly to config.js / firebase-config.js
  lockExternalConfig: true
};
