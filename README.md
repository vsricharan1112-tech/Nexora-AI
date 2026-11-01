# Nexora AI — public pilot

This repository contains the Nexora Node web app and its static assets. It has no runtime npm dependencies. Deploy it as a Render Web Service using the included `render.yaml`.

## Runtime settings

- Render must set `HOST=0.0.0.0`; it provides the `PORT` value automatically.
- Add `OPENAI_API_KEY` as a Render environment secret to enable NEXA. Never commit the key.
- Add `NEXORA_ADMIN_TOKEN` as a Render environment secret before using mentor approval routes.
- The free Render service sleeps when idle and has an ephemeral filesystem. Live room state clears on restart, and mentor application files can be lost. Use this deployment as a demo until persistent storage is configured.

No mentor data, local profile data, `.env` file, or API key is included.
