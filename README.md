# Nexora AI

Nexora is a student planning and opportunity web app served by the small Node server in `nexora-server.cjs`. The hosted pilot is https://nexora-ai-1ocm.onrender.com.

## Features that work in the current app

- Study dashboard, task planner, habit tracker, progress view, roadmap, ranking scenarios, option comparison, profile, saved reading list, and mistake review save in the current browser.
- Learn links open live sources including Khan Academy, NPTEL, MIT OpenCourseWare, SWAYAM, YouTube, and web search.
- Scholarship, student-offer, and workshop pages link to official or current listing/search pages. Nexora does not ingest or verify those sites' listings automatically; check eligibility, deadlines, and terms on the source site.
- Study rooms and mentor applications use the server. Rooms are temporary in-memory sessions. Mentor applications and approvals currently use the server's data directory.
- NEXA's server route calls the Gemini API when `GEMINI_API_KEY` is configured. The free tier has quotas and Google says free-tier content may be used to improve its products; NEXA does not send data to Gemini unless its owner configures a key and a user submits a prompt.
- Optional email/password accounts and cross-device workspace sync are implemented with Supabase Auth and the private table defined in `supabase-schema.sql`.

## Enable accounts and cloud sync

1. The Supabase project is `ourtukxcjmisguxviulg`; its private workspace table and the hosted site/redirect URLs are configured. On the Free plan, Supabase may pause a project after a week of low activity; do not promise continuous production availability from a free project.
2. In the Supabase SQL Editor, run all of `supabase-schema.sql`. Its row-level security policies limit each account to its own workspace row.
3. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the Render service environment. `render.yaml` has the project URL and prompts for the publishable key without storing it in Git. The publishable key is designed for browser use and is restricted by row-level policies; never use the secret/service-role key in the browser.
4. In Supabase Authentication settings, allow the hosted website URL for site and redirect URLs. Email verification and password reset rely on Supabase email delivery; configure a reliable SMTP sender before inviting real users.
5. Redeploy. The cloud button should show `Sign in`; create an account, verify the email if requested, and sign in. Existing browser data is copied to the account on first sign-in. Later changes sync automatically. Large images may remain only on the device.

## Enable live NEXA AI

Create a free-tier key in Google AI Studio and add `GEMINI_API_KEY` as a **secret environment variable** in Render, never in HTML, GitHub, or a message. Keep Google Cloud billing disabled to avoid paid usage. Google currently lists `gemini-2.5-flash-lite` as free of charge for standard input/output; quotas can be exhausted, and Google may use free-tier content to improve its products. After redeploy, `/api/health` should show `aiConfigured: true`; test a question in NEXA. Answers do not include web citations.

## Host limits and launch status

This project is deployed as a free Render web service. Free instances can sleep while idle, wake slowly, restart, and lose files stored on the service. A successful health check does not mean the app can never crash. The free deployment is a public pilot, not an uptime or data-retention guarantee.

Before relying on it for real users, add persistent storage for mentor applications, approved mentors, and room state; configure a non-free always-on web service and durable database with backups; configure production email; and review the privacy, abuse-reporting, moderation, and student-data policies. Never publish real mentor contact details without their consent.

The public resource links are deliberately outbound links rather than scraped feeds: scholarship awards, offers, and workshops change, and eligibility must be checked with the awarding organization. NEXA sends prompts to Gemini only after the owner configures `GEMINI_API_KEY`; answers do not include web search or citations.
