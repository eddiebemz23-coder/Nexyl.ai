// Neon infrastructure-as-code for Nexyl.ai. The CLI evaluates this file; the body is plain
// JavaScript except for the import specifier.
//
// `neon deploy` applies it to the linked branch: it bundles src/function/index.mjs into one
// ESM entry, uploads it with the env values read from .env.neon, and gives the function a
// public HTTPS URL in the same region as the database (with DATABASE_URL injected).
import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  functions: {
    // Slug is the function's permanent identity and appears in its URL: ^[a-z0-9]{1,20}$
    api: {
      name: 'nexyl api + frontend',
      source: 'src/function/index.mjs',
      // Values come from .env.neon (`npm run neon:env`). A missing value is undefined and
      // defineConfig throws rather than uploading an empty secret.
      env: {
        JWT_SECRET: process.env.JWT_SECRET!,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
        NEXYL_LLM_MODEL: process.env.NEXYL_LLM_MODEL!,
        PG_POOL_MAX: process.env.PG_POOL_MAX!,
      },
    },
  },
});
