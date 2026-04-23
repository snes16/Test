import OpenAI from "openai";

export function getModelFromEnv(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
}

export function createOpenAIClientFromEnv(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Set it in your environment or .env file.");
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
  });
}
