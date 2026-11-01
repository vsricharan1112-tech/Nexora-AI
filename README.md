# Nexora AI

Nexora is a student planning and learning web app. The public deployment is at <https://nexora-ai-1ocm.onrender.com>.

## Working features

- Study dashboard, planner, habit tracker, progress view, roadmap, ranking scenarios, option comparison, profile, saved reading list, and mistake review. Most of this workspace is stored in the current browser; signed-in users can sync supported workspace data through Supabase.
- Learn resources link to Khan Academy, NPTEL, MIT OpenCourseWare, SWAYAM, YouTube, and search pages. Scholarship, offer, and workshop pages link to official portals and search results. These are outbound links, not complete live feeds, and users must confirm deadlines and eligibility with the source.
- Study rooms and mentor submissions use Supabase tables with row-level security when the hosted Supabase connection is configured. Rooms require a signed-in account. Presence expires after 25 seconds offline; messages older than seven days are removed when that room is polled. Pending mentor applications are private. An administrator must approve a profile before it appears publicly.
- Email/password accounts and workspace sync are implemented with Supabase Auth. The hosted service has the public Supabase URL and publishable key. Public sign-up is not ready until the owner configures the auth site/redirect URLs and production SMTP in Supabase, then tests email verification and password recovery.
- NEXA calls Google Gemini from the server only when `GEMINI_API_KEY` is present. It is currently off if that secret is absent. The free tier has quotas and Google may use unpaid-tier content to improve its products. NEXA does not do web search or provide citations; use the Explore links to verify answers.
- The privacy and terms pages describe data use, deletion, support, external links, and service limits. The account panel includes self-service account/cloud deletion and public GitHub support links.

## Supabase setup already applied

The project is `ourtukxcjmisguxviulg`. `supabase-schema.sql` defines private workspace sync; `supabase-public-features.sql` defines room and mentorship data with row-level security. The latter is applied to the connected project. The Render service needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`; never put a service-role key in the browser or repository.

The `delete-account` Edge Function verifies the caller’s Supabase session before deleting that same Auth user. Supabase foreign-key cascades remove linked workspace, room, and mentorship rows. The UI also clears Nexora browser data on the device used for deletion. Its service-role key is read only from Supabase’s Edge Function environment.

For the public email flow, set Supabase Site URL to `https://nexora-ai-1ocm.onrender.com`, allow `https://nexora-ai-1ocm.onrender.com/**`, and configure a custom SMTP provider in Supabase Authentication. The default sender is restricted and is not suitable for public sign-up. Test sign-up, verification, sign-in, password reset, and cross-device sync before inviting users.

To enable the admin review panel, first create and verify the owner's account. A project owner must then set `nexora_admin: true` in that user's **app metadata** (never user metadata) using a trusted Supabase admin process. This server checks the signed-in user's trusted app metadata and database RLS. Do not expose a service-role key to the app.

## Enable live NEXA

Create a Gemini API key in Google AI Studio and store it privately in Render as `GEMINI_API_KEY`, then redeploy. Do not put the key in HTML, GitHub, or chat. Keep billing disabled if only free use is intended; quotas can still be exhausted. Check `/api/health` for `aiConfigured: true` and try a real question.

## Hosting and launch limits

Render's free web service can sleep while idle and take time to wake. Free services do not promise continuous availability. Supabase's free plan also has limits and may pause projects after extended inactivity. A health check or passing automated tests cannot guarantee that a service will never fail.

Before inviting the public, configure production SMTP and test sign-up, verification, sign-in, password recovery, and cloud sync with a real account. Add the Gemini key if AI is part of the launch promise, create the owner admin claim, and test moderation and room flows with real accounts. The current support link opens a public GitHub issue tracker; a private support contact still needs to be chosen. Never post personal or account information there. Review all external links and source listings regularly.

