# Nexora AI — public pilot

This repository contains the Nexora Node web app and its static assets. It has no runtime npm dependencies. Deploy it as a Render Web Service using the included `render.yaml`.

## Runtime settings

- Render must set `HOST=0.0.0.0`; it provides the `PORT` value automatically.
- NEXA uses the OpenAI Responses API with `gpt-4.1-mini` and web search. To enable answers, the site owner must add `OPENAI_API_KEY` as a Render environment secret. Never put the key in the HTML or GitHub repository.
- OpenAI API usage is billed separately from ChatGPT. Set API project usage limits before sharing a live AI key.
- Add `NEXORA_ADMIN_TOKEN` as a Render environment secret before using mentor approval routes.
- The free Render service sleeps when idle and has an ephemeral filesystem. Live room state clears on restart, and mentor application files can be lost. Use this deployment as a demo until persistent storage is configured.

## Publish checklist

1. Deploy the `main` branch on Render.
2. In the Render service's **Environment** page, add `OPENAI_API_KEY` as a secret, then save and redeploy. Keep the key private.
3. Open `/api/health`; after the key is set, it should say `aiConfigured: true` and `aiModel: "gpt-4.1-mini"`.
4. Ask NEXA a test question on the site. A missing or invalid key, unavailable API billing, or an API limit will show a retry message.

Planner, profile, tracker, and other personal workspace data stay in each browser's local storage. Shared rooms are temporary in-memory demo rooms. Mentor applications need persistent storage and an admin token before they should be used for real users.

No mentor data, local profile data, `.env` file, or API key is included.
