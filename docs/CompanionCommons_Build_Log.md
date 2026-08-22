# CompanionCommons — Build Log & Learning Reference

This is a plain-language record of what's actually been built, from the very first working session through today. For each piece of work: what we did, why we did it, and what tools/services were involved.

---

## August 12, 2026 — Naming the Business & Designing the Data Collection System

This is where the actual product design work started, across a few connected sessions the same day.

### 1. Renamed the project and settled the business model

**What we did:**
The project started under the working name "PetMetrics" and was renamed to CompanionCommons. Locked in the core business model: a free-forever consumer side (senior dog owners logging their dog's health weekly) funding a paid enterprise side (selling anonymized, aggregated versions of that data to pet insurers, pharmaceutical companies, and supplement brands).

**Why:**
Before building anything, it's worth being clear on what the business actually *is*. This is a data platform, not a company that sells pet products — a distinction that mattered enough to come up repeatedly in later sessions too.

**Supporting services/tools:** none yet — this was planning and naming.

### 2. Designed the data collection framework

**What we did:**
Built the actual questionnaire design: a one-time "baseline" survey at signup (breed, age, sex, spay/neuter status, current vet care, supplement use) plus six weekly questions covering morning stiffness, activity level, stairs/jumping, recovery after exercise, pain signals, and appetite. All of it mapped onto a single 1–8 scoring scale, used consistently from the very first baseline answer through every week after — so week 1 can always be compared against week 0 on the same scale.

**Why:**
This is the actual product. Getting the questions and scoring right up front — using one consistent scale instead of different scales for different questions — is what makes 12 weeks of answers usable as real comparable data later, instead of just a pile of disconnected survey responses.

**Supporting services/tools:** none yet — this was framework design, later built into the real signup and check-in forms.

### 3. Built example outputs to show what the data would actually produce

**What we did:**
Created a sample dataset showing what insights this kind of tracking could eventually generate for a buyer (like "dogs on a certain supplement showed X% better mobility than dogs not on it"), then built two things to demonstrate that: an interactive dashboard for buyer presentations, and a slide deck aimed at different buyer types (insurers, pharma companies, supplement brands).

**Why:**
It's one thing to say "we'll collect useful data" — it's another to show a potential enterprise buyer exactly what they'd get. This built a concrete example of that pitch.

**Supporting services/tools:** none — presentation materials only, not connected to the live product.

### 4. Set up the admin panel (edit website text without touching code)

**What we did:**
Built a password-protected admin page where website text (headlines, button labels, body copy) can be edited directly and go live immediately — no code changes needed. Took a couple of tries to get right: the first attempt (a separate HTML file) kept hitting file-path errors, so it was rebuilt with the admin page's HTML written directly inside `server.js` itself, which sidestepped the problem entirely.

**Why:**
This lets website copy get updated without needing a developer (or Claude) involved every time, and without needing to push new code for a simple text change.

**Supporting services/tools:**
- `server.js`
- Supabase (a new `page_content` table holds the editable text)

### 5. Attempted, then abandoned, real-time Google Sheets syncing

**What we did:**
Spent significant time trying to get new signups to automatically flow into a Google Sheet in real time, using a Google Cloud service account. Ran into a string of setup problems (a file accidentally named with two `.json` extensions, a typo'd service account email, permission errors that persisted even after they should have been fixed). Set this aside and kept using a simple local backup file (`signups.json`) plus Supabase instead.

**Why:**
Real-time Google Sheets syncing would have been a nice-to-have, not a requirement — and after a couple of hours without resolution, it wasn't worth continuing to chase versus just moving forward with what was already working (Supabase).

**Supporting services/tools:**
- Google Cloud (attempted, not completed)
- Supabase (what was actually used instead)

---

## August 14, 2026 — Planning Documents & the Mobile App Decision

**What we did:**
Created seven planning documents covering the full roadmap: a Phase 0 operations manual, a 4-phase product build roadmap, a plan for where AI features would fit in over time, the full survey question roadmap (with legal guardrails — never asking anything that would count as medical advice), a 4-phase data security plan (starting free, scaling up to formal SOC 2 certification later), and two competing mobile app plans. Landed on a hybrid mobile approach: learn React Native and build most of the app personally over about 3 months, then bring in a paid contractor for the hardest 30% (push notifications, offline syncing, app store submission) in month 4.

**Why:**
This was the "big picture" planning session — mapping out not just what to build next, but how far out the whole plan goes, and making a real decision on the mobile app (build it all personally vs. hire it all out vs. a mix) rather than leaving it undecided.

**Supporting services/tools:**
- No new services — this was planning and roadmap documents, later referenced repeatedly

---

## August 16, 2026 — Site Cleanup, Baseline Rename, Broken Signup Buttons

**What we did:**
A full pass fixing real bugs on the live signup path:
- Renamed the baseline survey page (dropping the word "survey" from user-facing text, since "survey" and "data" language was flagged as something to avoid in front of actual visitors — old links still work, redirected to the new page)
- Found and fixed **5 different "sign up" buttons across the homepage that all pointed to a dead anchor link** — meaning nobody landing on the homepage could actually sign up at all. Same problem found and fixed on two other pages.
- Retired an old, disconnected signup popup on the "Founding Member" page that wrote to database tables nothing else in the app ever reads from — meaning anyone who signed up through it would never show up on a dashboard or get a reminder text
- Added several new fields to the signup form (weight, spay/neuter status, zip code, diet type, pet insurance, and a broad treatment category) — deliberately keeping medication questions at a category level only ("anti-inflammatory," not a specific drug name or dose), to avoid a legal reporting requirement that applies to more specific medication data
- Fixed a `.gitignore` bug (the file that tells Git which files to skip) that could have accidentally hidden two important files from version control
- Manually tested the entire signup pipeline start to finish and confirmed it actually works

**Why:**
The dead sign-up buttons were the standout find — a real, silent conversion killer. Someone excited enough to visit the homepage and click "sign up" would have hit a dead end, with nothing telling anyone that was happening. Worth fixing before anything else.

**Supporting services/tools:**
- `server.js` and the site's HTML pages
- Supabase (new columns added)
- GitHub

---

## August 17–18, 2026 (Session 1) — Check-In Expansion, SMS Fix, First Production Deployment

This was the session where the site went from "only runs on John's own computer" to "live on the real internet." Several distinct pieces of work happened.

### 1. Expanded the weekly check-in

**What we did:**
The weekly check-in form only ever asked about mobility. We expanded it to also ask about energy and appetite every week, plus a cognitive/behavior question every 4th week (weeks 4, 8, 12) — matching what the site's own marketing page (Pet Health Library) had already been promising.

**Why:**
The site was making a promise ("we track mobility, energy, and cognitive health") that the actual form didn't deliver on. This closed that gap.

**Supporting services/tools:**
- `server.js` (the check-in form logic and the database save logic)
- Supabase (added new columns to hold the new scores)

### 2. Fixed the SMS reminder system

**What we did:**
Discovered the weekly SMS reminder system had never actually worked, since it was built to look up phone numbers in a database table that the real signup process never filled in. Rewired it to use the phone numbers that are actually saved.

**Why:**
Without this fix, no real user would have ever received a single reminder text, silently. That's the core mechanism meant to keep people logging every week — if it's broken, the whole retention loop doesn't function.

**Supporting services/tools:**
- `server.js`
- Supabase
- Twilio (the service that actually sends the text messages)

### 3. Fixed a real legal compliance gap (TCPA)

**What we did:**
Found that the checkbox where someone consents to receive SMS reminders wasn't actually being checked before texts went out — anyone with a phone number on file got texted regardless of whether they'd agreed. Fixed the reminder-sending logic to actually respect that checkbox.

**Why:**
Texting people without consent is a real legal risk (TCPA is a U.S. law governing unsolicited text messages). This wasn't a nice-to-have — it needed fixing before any real users came on board.

**Supporting services/tools:**
- `server.js`
- Supabase (added a `sms_consent` column)

### 4. Found and properly linked the site's legal pages

**What we did:**
Discovered the Terms of Service and Privacy Policy pages actually already existed (had been written days earlier) but were only reachable from one obscure page on the site. Added footer links to both from every page.

**Why:**
Legal pages that exist but that a visitor can't actually find don't do much good — and as it turned out, having them properly live and linked became a hard requirement for a completely separate task (see Twilio, below).

**Supporting services/tools:**
- The site's HTML pages
- GitHub

### 5. Built a "Coming Soon" password lock for the whole site

**What we did:**
Built a system where setting one setting (`SITE_PASSWORD`) locks the entire site behind a password screen — except for the Terms, Privacy, and a couple of technical pages, which always stay open no matter what.

**Why:**
The site wasn't ready for real visitors yet, but it needed to go live on the real internet (not just John's computer) for other reasons — including Twilio's requirements, below. This let the site be technically live and reachable, while still keeping regular visitors out until John was ready.

**Supporting services/tools:**
- `server.js`
- Railway (where the `SITE_PASSWORD` setting actually lives once deployed)

### 6. Fixed a hardcoded local address

**What we did:**
Every link ever sent to a user (in a text or email) was hardcoded to John's home WiFi address, meaning it would only work on his own network — not from a real user's phone anywhere else. Replaced it with a setting that automatically uses the right address depending on where the app is running.

**Why:**
Without this, literally no real user could have ever clicked a working link from a text message or email. This was a silent, total blocker.

**Supporting services/tools:**
- `server.js`

### 7. First production deployment (Railway)

**What we did:**
Deployed the app for the first time to Railway, a cloud hosting service. Hit and fixed two real errors along the way: the server was set to use an old version of Node.js that didn't support a library it needed, and a folder-name mismatch (`public` vs `Public`) that works fine on Windows but breaks on Railway's servers because of a case-sensitivity difference.

**Why:**
This is the step that actually put the app on the real internet for the first time, rather than only existing on John's own machine.

**Supporting services/tools:**
- Railway
- GitHub (Railway builds directly from what's pushed there)

### 8. Pointed the real domain at the live site

**What we did:**
Connected `companioncommons.com` (already owned, but not pointing anywhere) to the new Railway deployment.

**Why:**
So the actual companioncommons.com address people would type or click on actually shows the real site.

**Supporting services/tools:**
- Porkbun (where the domain is registered)
- Railway

### 9. Submitted the Twilio SMS campaign for approval

**What we did:**
Filled out and submitted Twilio's official registration (called "A2P 10DLC") that's required before a business can send text messages to a large number of phone numbers.

**Why:**
Without this approval, Twilio blocks bulk SMS sending — this is a required step before real reminder texts can go out at scale. This is also why the site needed to be genuinely live with real Terms/Privacy pages (Twilio's own rules, updated June 30, 2026, require that).

**Supporting services/tools:**
- Twilio

### 10. Migrated off a locked Gmail account

**What we did:**
John's business Gmail got locked mid-session. Rather than wait, moved every connected account (SendGrid, GitHub, Supabase) over to a new email address, and fixed a real bug found along the way — the "we noticed you haven't logged in a while" email was accidentally hardcoded to always send to one test address, instead of the real dog owner's own email.

**Why:**
Being locked out of the account tied to several other services was a real operational risk; better to migrate immediately than risk being stuck. The hardcoded-email bug was a genuine functional problem worth fixing regardless.

**Supporting services/tools:**
- Gmail
- SendGrid (sends the actual emails)
- GitHub
- Supabase
- Porkbun (set up `hello@companioncommons.com` to forward to the new address)

---

## August 18, 2026 (Session 2) — AI Retention Features

This session built and shipped five real features, in a deliberately chosen order, plus caught and fixed two genuine bugs along the way.

### 0. Reconciled a messy checklist

**What we did:**
Found that the project's own planning checklist had accidentally listed some features twice under two different names (from two different planning sessions). Cleaned that up so there was one clear list to build from, and reordered the build priority based on which feature would actually help retention first.

**Why:**
Building the same feature twice under two different names wastes real time. Worth five minutes of cleanup before writing any code.

**Supporting services/tools:**
- The project's own planning documents (markdown files)

### 1. STEP 27B — Post-Log Micro-Insights

**What we did:**
After someone submits their weekly check-in, they now see a specific, varied message about whatever changed the most (mobility, energy, appetite, or cognitive) — not just a generic "thanks for logging."

**Why:**
This is the single biggest lever for making logging feel worthwhile *immediately*, rather than only paying off after weeks of data. Without it, submitting a check-in felt like shouting into a void.

**Supporting services/tools:**
- `server.js`
- Supabase (reads the dog's last check-in to compare against)

### 2. STEP 27C — Streak Gamification

**What we did:**
Added a visible streak counter (🔥 "3 week streak") on both the confirmation screen and the dashboard, plus celebratory messages at 2/4/8/12-week milestones. Deliberately chose to only store a dog's *best-ever* streak in the database — the current streak is recalculated fresh every time, so there's nothing that can quietly get out of sync.

**Why:**
Streaks are a well-known way to encourage people to keep a habit going. Calculating the current streak live (instead of storing it) means there's one less thing that can silently break or drift wrong over time.

**Real bug caught here:** the code that calculates which "week number" a check-in belongs to had no safety floor, so an unusual date (like a test entry set slightly in the future) could produce "week 0" — which then silently broke the streak count entirely. Fixed by adding the same safety check that was already protecting a different part of the app.

**Supporting services/tools:**
- `server.js`
- Supabase (one new column added: `longest_streak`)

### 3. STEP 27D — Health Alert Triggers

**What we did:**
When a dog's score on any metric jumps or drops by 2 or more points compared to last time, a banner appears on their dashboard: "⚠️ Worth a look." It only shows up once every 14 days per metric+direction (so a decline alert doesn't drown out a later improvement, and vice versa), and it never diagnoses anything — it just says the change is worth mentioning to a vet.

**Why:**
This is meant to be the feature that makes the app feel like a genuine health tool, not just a diary. Careful attention was paid to never crossing into medical advice, since the whole project is explicitly built to be a data platform, not a substitute for a vet.

**Real bug caught here:** the very first version blocked ANY repeat alert for the same metric, regardless of direction — meaning a decline alert would have silently prevented a later "good news, it's back up" alert from ever showing for two weeks. Fixed by making the 14-day cooldown track improvements and declines separately.

**Supporting services/tools:**
- `server.js`
- Supabase (one new table added: `health_alerts`)

### 4. STEP P1B — Smart Defaults

**What we did:**
When someone opens the check-in form, the sliders now start at whatever they logged last time (instead of a generic default), so a "normal" week takes just a couple of taps to confirm. Also fixed the fallback for a dog's very first check-in — it now starts from the score the owner actually gave at signup, not an arbitrary number.

**Why:**
Small friction adds up. Making the common case (nothing much changed this week) fast to complete is one of the simplest ways to support the "logging takes 90 seconds" goal.

**Supporting services/tools:**
- `server.js`

### 5. Wiped all test data

**What we did:**
Deleted every test dog and its history across all the related database tables, after confirming with John that zero real founding members existed yet.

**Why:**
Weeks of manual test-data edits (fake dates, duplicate entries) had made the test data too tangled to trust anymore. A clean slate meant future testing would give clear, believable results.

**Supporting services/tools:**
- Supabase

### 6. STEP P1D — Content Rewards (Breed Guides)

**What we did:**
Built a reward that unlocks after a dog's second week of check-ins: a short guide about their specific breed (history, temperament, general senior-health patterns), shown alongside the dog's own photo and current score. Covers the 30 breeds John specified (by real weight class), plus a fallback for any other breed. Deliberately built without any AI-generation step and without any "compared to other dogs" claims, since there isn't yet enough real user data to make honest comparisons.

**Why:**
This is a retention reward — something tangible an owner gets in exchange for logging consistently, beyond just seeing their own chart. Skipping AI generation and cohort comparisons for now avoided adding a costly new dependency and avoided making claims the data can't yet back up.

**Supporting services/tools:**
- `server.js` (all 30 breed write-ups live directly in code, not a database table)
- Supabase (checks the dog's current week and pulls their photo)

### 7. Diagnosed and resolved a real Railway platform outage

**What happened:**
The push for STEP P1D kept failing to actually go live — three separate attempts, three different failure messages each time ("failed to connect before deadline," "failed to build image" after an unusually long 38+ minutes, and finally "no build logs were found at all"). Despite this, the code itself checked out clean every time: it built successfully, it was verifiably present and correct on GitHub, and it had already been tested and confirmed working locally.

Rather than guessing, worked through it like a real troubleshooting process:
1. Confirmed the code was actually correct and present in the pushed commit (checked directly on GitHub, not just trusting Railway's build summary)
2. Confirmed no new dependencies had been added that Railway would need to newly install
3. Found Railway's own public status page showing an active, acknowledged incident ("Deployments are slow to progress") that matched the timing exactly
4. Found a matching report from another Railway user hitting the identical symptom pattern, with Railway's own support team confirming it was tied to that same incident
5. Waited for Railway's status page to show the incident fully resolved, then ran one more clean deploy attempt — which succeeded

**Why this is worth including:** it's a good real-world example of how to diagnose "is this my fault or theirs" methodically instead of guessing — checking the actual pushed code, checking a platform's public status page, and searching for other people hitting the same specific error, before concluding it's an external problem rather than assuming (or panicking) either way. The site stayed fully functional the entire time on the previous version; nothing was ever broken for real users.

**Supporting services/tools:**
- Railway (deployment, live runtime logs, and their public status page)
- GitHub (used to verify the actual pushed code, independent of what Railway's UI reported)
- Railway's community forum ("Central Station") — found a matching report from another user there

### 8. Confirmed the email forward is working

**What we did:**
Confirmed that `hello@companioncommons.com` is now actually delivering to the real inbox — this had been left unconfirmed at the end of the previous session.

**Why:**
Closes out a loose end from Session 1 — the site's Terms and Privacy pages promise "email us at hello@companioncommons.com," and this confirms that promise is actually real.

**Supporting services/tools:**
- Porkbun (email forwarding)
- Gmail

---

## August 19, 2026 — Google Sheets Integration Rebuilt From Scratch

This closed out the last banked item from the checklist — real-time export of every signup and check-in into a live Google Sheet.

### What we did

**Found and fixed the real reason it never worked.** The original attempt (Aug 12) had code that looked for a credentials *file* sitting on the server's disk. That was never going to work once deployed — the credential file correctly never got committed to GitHub (committing secrets to a repo is a real security mistake), so the file was simply never present on Railway. Every single startup log all session had been quietly showing "key file not found" — now we know why.

**Rebuilt it to use an environment variable instead**, matching what the checklist had already planned. Along the way, also found:
- The signup code that used to call the Google Sheets export was in `/api/signup` — a **dead route** nothing on the live site actually calls anymore, left over from before the current signup system existed. Deleted it entirely rather than fix code nothing uses.
- The real export now hooks into the two routes that actually run for real users: `/verify` (where a real signup profile gets created) and `/api/checkin-senior` (every real weekly check-in).
- Split the data into two clean tabs in one spreadsheet — `Signups` and `CheckIns` — instead of cramming different shapes of data into one flat sheet.

**Set up Google Cloud from scratch** under the new (unlocked) Gmail account: created a project, enabled the Sheets and Drive APIs, created a dedicated service account, generated a credentials key, created the actual spreadsheet, and shared it with that service account.

**Hit and fixed several real setup snags along the way** — worth knowing about since they're easy to hit again:
- A credential that briefly appeared in a screenshot was treated as compromised and rotated (deleted, regenerated) as a matter of good practice, even though its access was narrow (only that one Sheet).
- Raw JSON credentials pasted directly into a `.env` file can break, because some `.env` parsers convert the literal `\n` characters inside the credential's private key into real line breaks, corrupting it. Fixed by base64-encoding the credential before storing it, and decoding it back in code — a more robust standard practice for this exact situation.
- A Railway environment variable got created under the old name (missing a `_BASE64` suffix) during a rename attempt that didn't fully take — Railway's simple variable editor only lets you edit values, not names; had to use its "Raw Editor" to actually fix the name.

**Tested end-to-end twice** — once locally, once for real on the live `companioncommons.com` domain — confirming both a real signup and a real check-in correctly appear in the Sheet within seconds.

### Why

This is the raw-data backup and working layer John actually works from day to day — a live, human-readable copy of every signup and check-in, outside of Supabase, updating in real time. The dead-code and credential-format issues were the actual reasons the first attempt (weeks earlier) never worked; worth understanding why, not just that it's fixed now.

### Supporting services/tools
- Google Cloud Console (project, APIs, service account, credentials)
- Google Sheets (the actual spreadsheet)
- Railway (environment variable storage)
- `server.js`
- PowerShell (used to safely generate the base64 credential without ever displaying or pasting the raw key)

---

## August 19, 2026 (continued) — Twilio Goes Live, Dashboard Rebuilt, Real Bugs Found Through Real Testing

This was the session where the site's biggest blocker cleared for real, and where testing with an actual working phone number surfaced a string of genuine bugs that had been sitting invisible until real SMS could finally reach a real device.

### Twilio A2P 10DLC campaign approved — and confirmed actually working

**What happened:** Twilio approved the campaign. Completed one more required step (attaching the phone number to the approved campaign, which showed as a separate pending "onboarding task") and then tested for real: submitted a live signup with a real phone number and a real text arrived in 7 seconds, with a working verification link.

**Why it matters:** This was the single blocker sitting over the whole project since the first session — until this cleared, real people literally could not complete signup, because the verification link only arrives by text. Confirmed the whole real chain works: signup → real SMS → real link → real profile → real dashboard → real check-in → real Google Sheets export.

**Supporting services/tools:** Twilio

### Dashboard rebuilt: no more fake "empty state," a real 7-day gate, and mid-week notes

**What we did:**
- Removed the old placeholder page that showed when a dog had zero check-ins. Real users were clicking its only button ("Record First Check-In") thinking that was how you access the dashboard at all — it wasn't, it just looked that way. The dashboard now always shows real content (photo, baseline score, chart), using the baseline survey answers as the starting data point before any check-in exists.
- Added a genuine 7-day waiting period between signing up and a dog's first weekly check-in becoming available — matching the real intended cadence, not letting someone check in the same day they signed up. The dashboard shows a live countdown ("Available in 6 days," "5 days," etc.) that counts down correctly.
- This is enforced twice, not just cosmetically: the check-in page itself won't load early, and the actual save endpoint rejects an early submission too — closing the door on someone bookmarking or revisiting an old link before it's time.
- Relabeled the progress indicator so the baseline signup doesn't get counted as "Week 1" — it now shows "Baseline ✓ · Week X of 12," an accurate reflection of what's actually happened.
- Built a new mid-week notes feature — lets an owner jot down an observation any time (deliberately not gated by the 7-day rule, since the whole point is giving people a reason to open the dashboard between formal check-ins). Saves to its own database table and now also flows into a dedicated "Notes" tab in the Google Sheet, matching the same real-time export pattern as signups and check-ins.

**Why:** The empty-state page was a real, measurable UX problem — it created genuine confusion about how the product works, confirmed by directly watching it happen during testing. The 7-day gate matters because the original design intent (a real weekly cadence) wasn't actually being enforced anywhere before this.

**Supporting services/tools:** `server.js`, Supabase (new `dog_notes` table), Google Sheets

### Real bugs found through actual end-to-end testing (not just happy-path checks)

Once a real phone and real Twilio delivery were in play, several things that had been invisible during earlier testing (which mostly used manual database workarounds) surfaced for the first time:

- **Photo uploads were completely broken** — the code looked for a Storage bucket named `dog-photos`, but the bucket that actually gets created is named `Dog_Photos`. Simple case-mismatch, but it meant every single photo upload had been silently failing since the feature was first built.
- **"This Week at a Glance" was showing completely fabricated text** — three lines ("Getting up after rest has been more difficult for two weeks," etc.) were hardcoded, identical on every dog's dashboard regardless of any real data. Rebuilt to show real trend comparisons for Mobility, Energy, and Appetite based on actual check-in history.
- **Literal placeholder text `[dog_name]`** was showing verbatim in two places — once on the dashboard, once in the "we haven't heard from you" re-engagement email — instead of the dog's actual name. Both were simple unfinished template variables that had never been wired up.
- **Mobile layout overflow** — several buttons and banners were built with a CSS rule (`white-space: nowrap`) that's harmless on desktop but forces the whole page wider than a phone screen, since the text isn't allowed to wrap. Added a dedicated mobile breakpoint that lets these wrap and stack properly.
- **Chart readability when multiple metrics share the same value** — with mobility, energy, and appetite plotted as three overlaid lines, weeks where all three happened to be equal showed only one visible dot, hiding the other two underneath. Tried a few approaches (different point shapes, then different point sizes with transparency) before landing on the simplest, most robust fix: small uniform dots, with each line using a distinct dash pattern (solid/dashed/dotted) instead of relying on marker size or layering. Also added a plain data table under the chart showing exact weekly numbers, so reading precise values never depends on the chart's visual clarity in the first place.

**Why this cluster of bugs matters as a group:** every one of these had been sitting invisible during earlier testing, which mostly relied on manually grabbing tokens from Supabase rather than a real phone completing a real flow. This is a good example of why testing through the *actual* real path — not a shortcut — matters: none of these would have surfaced otherwise.

**Supporting services/tools:** `server.js`, Supabase Storage, Chart.js

### Homepage: real photos and illustrations installed

**What we did:** Replaced the placeholder illustrations in the homepage's community visual with real content — three real dog photos and three real hand-drawn-style illustrations, alternating around the circle, plus a new founder photo (John and his dog) properly relocated to the correct image folder after initially landing in the wrong one. Cleaned up a handful of stray files and an accidentally-created duplicate folder along the way.

**Why:** The circular "community" graphic on the homepage had three genuinely empty placeholder bubbles and some layout drift; this was already flagged as needing fixed earlier and is now real.

**Supporting services/tools:** `index.html`, `styles.css`, image conversion tools

### Dashboard: real baseline survey data now actually shown

**What we did:** The "Baseline Score" box only ever showed the mobility number. Split it into three clearly labeled sections (Mobility / Energy / Appetite). Added the dog's fixed/not-fixed status, diet type, and pet insurance status to the header — all real answers from the baseline signup survey that were being collected but never displayed anywhere. Added a new line showing any medications/treatments selected at signup.

**Why:** All of this data was already being collected at signup — it just wasn't showing up anywhere on the dashboard. A real gap between what the survey asks and what the owner (or a vet, in conversation) can actually see.

**Supporting services/tools:** `server.js`

### Google Sheets: added a real join key across all three tabs

**What happened:** Raised a real, well-founded question: with Signups, CheckIns, and Notes as three separate tabs, how do you reliably tie a row in one tab to the matching rows in the others? Dog names aren't unique, and email isn't a reliable per-dog key either. Fixed by adding the dog's own internal ID (already used throughout the app as the real identifier) as an actual column in all three tabs — a genuine, collision-proof way to match records across sheets.

**Why:** Without this, anyone trying to actually analyze the exported data would have no reliable way to connect a signup to its check-ins and notes for the same dog.

**Supporting services/tools:** Google Sheets, `server.js`

---

## Still Open — Not Yet Done

- **STEP P1C (Comparative Feedback)** — genuinely blocked. This feature shows how a dog compares to others of the same breed, which needs real data from real founding members to be honest. Can't be built meaningfully yet.
- **Lawyer review of Terms of Service / Privacy Policy** — the pages exist and are live, but haven't had an actual lawyer look them over yet.
- **Deciding when to actually open the site (`SITE_PASSWORD`)** — the real technical blocker (working SMS) is now cleared. This is genuinely just a decision now, not a dependency.
- **STEP P8 (full end-to-end testing)** — a complete, deliberate run-through of the whole signup → check-in → dashboard → reminder flow. Most of this has now actually been tested for real (with a real phone, real Twilio delivery) rather than piecemeal — worth one final clean pass before opening up.
- **"Journey Summary" button doesn't do anything yet** — found while making an unrelated text change. Clicking it currently just shows a browser popup saying "coming soon." Either needs to be built for real or hidden until it is.
- **Weekly reminder texts say "Week #0"** — spotted in a real reminder text that arrived during testing. A real, separate bug in the reminder-labeling logic, not yet investigated or fixed.
- **Chart fix should be re-confirmed** — the final version (small dots, distinct line dash patterns) was just shipped; worth one more look on a real dashboard with several weeks of matching data to confirm it reads cleanly.

---

## August 20, 2026 — Bug Fixes, Claude Code Migration, Site Polish, Security Fix, and Real Strategic Decisions

Long session, two distinct halves: the first half closed out the two known-open bugs from Aug 19 plus a site-wide polish pass; the second half was a genuine strategy conversation that reshaped how the business is positioned and how the beta will actually run. This was also the session John moved primary day-to-day building work from this chat interface into **Claude Code** (direct local file access, no more upload/download loop).

### Two known bugs from Aug 19, closed

- **"Week #0" reminder text bug** — root cause found: three separate places in `server.js` compute `currentWeek` from `(now - created_at)`, and two of them were missing the defensive `Math.max(1, ...)` floor that the third already had. If a dog's `created_at` timestamp is even slightly in the future relative to server time (clock skew, timezone edge case), the unguarded calculation floors to week `0` instead of `1`. Fixed both remaining spots (the live hourly churn-detection cron that actually sends real reminder texts, and its manual test-trigger twin) to match the third, already-correct version.
- **Journey Summary button** — previously just showed a "coming soon" browser alert. Built for real: a modal showing baseline-vs-current trends for all four metrics, a full week-by-week table, notes, any active health alert, and a "Print / Save as PDF" button styled to print cleanly on its own page (hides everything else via `@media print`). All data reused from what the dashboard route already loads — no new database queries. Iterated twice more per John's direction: added the full site vet disclaimer (matching the one used on the breed guide page, not a shortened version) plus a line noting community comparisons will appear here as the platform grows; then added the Companion Commons brand mark and the dog's own photo (or a placeholder) to the header, plus the dog's full baseline profile (breed, age, gender, fixed status, diet type, insurance status, medications/treatments) — the same data already shown on the dashboard, kept in sync by reusing the same fields and label lookup tables rather than duplicating them.

### A real, live bug found by accident: false breed-comparison claims on the dashboard

While setting up Claude Code, John spotted the dashboard's peer-comparison card claiming "How livetest compares with similar Labradoodle" — a specific breed claim. Investigation found the query behind it pulls **every dog in the database, with no breed filter at all** — the "similar Labradoodle" framing was never backed by real breed-matched data. A second, fully static instance of the same false claim (with an accidentally duplicated disclaimer line) was found elsewhere in the same file. Both fixed: relabeled as a community-wide comparison ("across the community" / "Community average"), with an honest disclaimer that it isn't breed-specific yet and real breed comparisons will come once enough dogs per breed are logging. This also directly reinforced the existing (but until-now-inconsistently-applied) decision that STEP P1C (real breed comparisons) stays blocked until real breed-cohort volume exists — this dashboard card had been quietly violating that decision in production.

### Migrated primary build workflow to Claude Code

John set up Claude Code (the Code tab in Claude Desktop) pointed at the real local project folder, after working through a few real setup snags — a stuck session pointed at a stale/nonexistent folder ("Folder not found," a known desktop-app bug with no clean in-app recovery), briefly landing in an unrelated placeholder demo project by mistake, and switching the model from Haiku 4.5 to Sonnet 5 for real build work. From this point on, most direct file edits happened in Claude Code rather than through this chat's upload/download loop — this chat shifted toward planning, investigation, review, and copy-pasteable instructions for Claude Code to execute.

### Site-wide typography and heading audit, then fixed

Ordered a full audit before touching anything. Found:
- The Google Fonts `<link>` tags (DM Sans, Newsreader) only existed in `index.html`'s `<head>` — all 11 other pages linking the shared `styles.css` were silently falling back to Arial/Georgia the whole time, despite the CSS correctly referencing the intended fonts via custom properties.
- Heading capitalization was genuinely inconsistent site-wide — no single rule in play, roughly a coin flip per page/section between Title Case and sentence case, sometimes both within the same page at the same heading level.

Fixed: added the missing font `<link>` tags to all 11 pages, fixed a hardcoded font-family override in `styles.css` that bypassed the shared variable, and set a real site-wide rule — **sentence case for H2/H3, proper Title Case for H1s specifically** (headline-style, matching a real editorial convention where the masthead reads slightly more formal than the body). Also fixed a footer tagline ("Pet families. Shared purpose.") that was inconsistently marked up as an `<h2>` on some pages and a plain `<p>` on others — standardized to `<p>` everywhere, since it's supporting text under the brand name, not its own heading.

**Supporting services/tools:** `server.js`, all `Public/*.html`, `styles.css`, Claude Code

### Founder photo fixed, decorative emoji replaced with a real icon set

- Found and fixed a broken founder photo on `about.html` — the path was missing the `assets/` directory entirely (`Images/Facing.JPG` instead of `assets/images/Facing.JPG`), which happened to still resolve on a local Windows test but would not work on a real case-sensitive server.
- Audited every decorative/brand emoji across the whole site (60+ instances) and replaced them with a real Lucide SVG icon set — recolorable, consistently sized, no more OS-dependent emoji rendering. Kept purely functional glyphs (✓ ✕ 📈 📉 ➡️ ⚠️ ❌) untouched, since those already read clean. Notably removed the 🐾 paw print from the "Companion Commons" brand label entirely rather than replacing it with an icon, since a placeholder brand mark isn't worth building ahead of the real logo (queued for after this visual pass).

**Why:** part of a deliberate push to make the site read as a credible data-intelligence platform rather than a casual pet app — directly connects to the RWE positioning decision made later in this same session.

**Supporting services/tools:** `server.js`, all `Public/*.html`, Lucide icon library (CDN)

### Real security fix: admin panel password was sent in plaintext

While placing icons on the admin route, found the admin panel's password check happened entirely client-side — the real password was sent in plaintext inside the HTML/JS delivered to the browser, meaning anyone who viewed page source on `/admin` had the real credentials with zero authentication required. Fixed properly: rebuilt to use the same server-side pattern already proven by the `SITE_PASSWORD` "Coming Soon" gate — a login form posts to a server route, the password is checked against an `ADMIN_PASSWORD` environment variable server-side, and a real cookie authorizes access. The password value itself never reaches the browser in any form. Verified in production, in a clean incognito session: no password visible in page source, correct password grants access, incorrect password is rejected.

One real deployment scare during this fix, worth remembering: John tested a mismatched password and got understandably alarmed, but investigation found the fix had never actually been committed — production was still running the original code the entire time. Nothing was ever live; the confusion was from testing local uncommitted changes against a memory of the real deployed behavior. Lesson reinforced: verify commit/push status directly (`git log`, `git status`) before assuming something is live, rather than testing behavior and inferring deployment state from it.

**Supporting services/tools:** `server.js`, Railway (new `ADMIN_PASSWORD` environment variable)

### Orphaned `Public/_to_delete/` folder removed

Investigated before deleting: confirmed the three files in this folder (old full-page versions of photo-upload-test, senior-dog-baseline-survey, senior-dog-mobility) had already been superseded by thin redirect stubs living directly in `Public/`, and that nothing anywhere in the codebase — no HTML links, no JS, no server routes — referenced the `_to_delete/` path. Since Express serves the whole `Public/` tree statically, these orphaned files were still reachable at their exact URL with zero access control, which was the deciding factor to delete rather than leave them. Removed, committed, and confirmed live (visiting the old URL now correctly 404s).

### Full privacy-policy audit against actual code — real gaps found, not just copy issues

Ordered a ground-truth audit of exactly what the app collects and stores, after spotting that `privacy.html` claimed zip code wasn't collected when it actually is. The audit found several real, previously-unknown issues, not just the one John spotted:

- **Zip code** is collected, required, and stored — but was listed under "what we do NOT collect."
- **The actual collected-data list was stale** — missing weight, spay/neuter status, diet type, insurance status, and medication/treatment category, none of which were mentioned on the privacy page despite being collected at signup.
- **Free-text notes and observations have zero content filtering or moderation** — a note containing real medical/medication detail would be stored verbatim and synced to Google Sheets in plaintext, while the privacy page promised veterinary records specifically weren't collected.
- **No consent record is ever actually stored.** The signup consent checkbox blocks form submission if unchecked, but the fact of consent itself — timestamp, what was agreed to — is never persisted anywhere. There's currently no auditable record that consent happened, for any signup.
- **A second, orphaned `users` table** gets a duplicate copy of email/phone/sms_consent written on every signup, with no link back to the dog record — dead weight increasing the real data-breach surface, confirmed non-functional (its schema doesn't match what the code tries to write, throwing a caught-but-logged error on every signup).
- **A stored-XSS gap**, found in passing: the Journey Summary modal renders note text unescaped, while the dashboard's own notes list correctly escapes the same field. Flagged as a real security bug, not yet fixed.
- **The one-time signup verification SMS is not actually gated by the SMS-consent checkbox** — it goes out unconditionally to complete account creation, regardless of that checkbox's state.

Rewrote the "Our core promise / What we collect / What we do NOT collect" section of `privacy.html` to accurately reflect the real data model as it stands today — moved zip code to the correct list, added the previously-missing fields, added an in-context disclosure directly under the notes textarea itself (not just buried in the privacy page) warning that notes aren't filtered before storage. The rewrite intentionally describes medication data at the current category-only level (see decision below), not drug-name level.

**Not yet fixed, flagged for later:** the missing consent record, the orphaned `users` table, and the stored-XSS gap are all real, separate from the copy fix — queued as open items, not resolved this session.

**Supporting services/tools:** `server.js`, `privacy.html`

### Major strategic decisions (see the companion documents for full detail)

The second half of this session was a deliberate step back from execution to re-examine direction — prompted by John wanting to confirm the build was still tracking the original vision after a day that had been almost entirely bug fixes and polish. This produced several real, load-bearing decisions:

- **Real-World Evidence (RWE) positioning** adopted as the company's core strategic frame — modeled on how Flatiron Health built structured, longitudinal, real-world treatment data for oncology, identified as the single clearest gap in the current pet-health market.
- **Firm rule: no consumer-facing scoring or predictions, ever** — a logger only ever sees their own dog's real data and trends, never a forward-looking claim about their specific dog. Predictive AI modeling, by contrast, is intended as a **major part of the B2B licensing product** — trained population-level models sold to buyers, not just raw data.
- **Medication data:** decided not to collect drug names or dosage yet, pending a real data-model separation (identifiable vs. de-identifiable fields) and specific lawyer review — full reasoning captured in the new legal-discussion document.
- **Free-text notes:** decided to keep allowing them freely, with the in-context disclosure now shipped, plus a firm new architectural rule that free-text fields must never flow into the B2B/licensing export — structured scores only.
- **Beta structure locked in:** 8 real strangers (sourced from the actual target persona, not people John knows) plus 2-3 close friends for honest qualitative feedback — up from the original 6-7, still deliberately small.
- **"Senior dog" resolved as intentional positioning, not leftover naming** — confirmed via review of the original Aug 12 planning docs and current shipping copy that senior dogs have been the real target audience since day one. Decision: keep senior-dog mobility as the market wedge and pitch focus, but open data collection to dogs of all ages, since non-senior data serves as a real analytical baseline and there's no technical age gate to remove.

See **`CompanionCommons_Strategy_and_Legal_Aug20.md`** for the full detail behind all of these decisions, including the competitive-positioning research and the complete list of questions prepared for lawyer review.

### Senior-by-breed-size flag and recurring weight tracking — built and shipped

Directly following the senior/all-ages decision above, built:

- **`isSeniorForBreed(age, breedName)`** — computed live (never stored), using real breed-size-tier senior-age thresholds (Giant ~5-6yo, Large ~6-7, Medium ~8-9, Small/Toy ~10-11) derived from each breed guide's existing typical-weight data, not a flat age cutoff. Shows as a small dashboard badge ("{dog} is considered a senior for their breed"), framed strictly as classification, never a health judgment. The breed guide page now branches: senior-flagged dogs see the existing senior-patterns copy unchanged; non-senior dogs see new, forward-looking "what to watch for as they age" copy, written per breed-size-tier.
- **Weight tracking made recurring** — previously collected once at signup and never updated. Now re-asked every 4th week, riding the same cadence already used for the cognitive/behavior question, as its own distinct field. Added a breed-typical-weight-range comparison ("within/above/below the typical range for {breed}"), shown non-diagnostically on the breed guide page. Added weight as a fourth trend line alongside mobility/energy/appetite on both the dashboard's "at a glance" section and the Journey Summary, using neutral up/down/steady language (not "improved/declined," since weight direction isn't inherently good or bad the way the other metrics are).
- **Added baseline weight as a fourth mini-column** in the dashboard's existing "Baseline Score" box, alongside Mobility/Energy/Appetite, with font/spacing shrunk slightly to fit without expanding the box. A mobile-specific fit issue was flagged at the end of the session, not yet resolved.

**Real deployment issues hit and resolved during this build, worth remembering:**
- A required database migration (`migration_add_checkin_weight.sql`) was written but never actually run in Supabase before the first live test attempt — caused a real 500 error on check-in submission. Claude Code correctly identified it does not have direct database access (only Supabase's REST API, not raw SQL execution) — John had to run the migration manually via Supabase's SQL Editor.
- The Google Sheets exports for both the Signups and CheckIns tabs needed real code fixes (weight was never being read into the Signups row at all; the CheckIns tab's row data was correct but its live header hadn't been manually updated to match) — both fixed, plus a manual header-column insert John did directly in the live spreadsheet for each tab.
- End-to-end verified with a real signup John personally completed, confirming baseline weight lands correctly in Supabase, the Signups sheet, and displays correctly on the dashboard.

**Supporting services/tools:** `server.js`, Supabase (new `mobility_checkins.weight_lbs` column), Google Sheets, Claude Code

---

## Still Open — Not Yet Done (updated Aug 20)

- **Lawyer review** — full list of specific questions now prepared, see the new legal-discussion document. Not yet scheduled.
- **Deciding when to actually open the site (`SITE_PASSWORD`)** — still genuinely just a decision, revisited directly this session; no blocker remains beyond John's own readiness criteria (see strategy document for the full "gate items" discussion).
- **STEP P1C (Comparative Feedback)** — still blocked on real breed-cohort volume; reinforced this session after finding a live violation of this exact rule on the dashboard.
- **STEP P8 (full end-to-end pass)** — still outstanding, and now larger in scope given everything shipped today.
- **Missing consent record** — no persisted proof that signup consent happened, for any user. Real gap, not yet fixed.
- **Orphaned `users` table** — duplicate PII with no link to the dog record, confirmed to also be throwing a schema error on every signup. Candidate for removal.
- **Stored-XSS gap in the Journey Summary modal** — unescaped note text render, found during the privacy audit, not yet fixed.
- **Mobile fit issue on the 4-column baseline score box** — flagged at the very end of the session, not yet diagnosed or fixed.
- **Data-model separation (identifiable vs. de-identifiable fields)** — flagged as a real architectural prerequisite before any future drug-name-level data collection, not yet started.

---

## August 21, 2026 — Mobile Fit Fixed, Full Message-Content Audit, Real Bugs Found and Fixed, Full Test Data Wipe

Shorter, tightly-scoped session focused on closing out remaining open items from Aug 20 and, more significantly, running a complete dry-run audit of every SMS and email a real logger would ever receive — without sending a single real message.

### Mobile fit issue on the 4-column baseline score box — fixed and verified

The overflow flagged at the end of Aug 20 turned out to be two independent, pre-existing bugs, neither of which was actually caused by the new Weight column:

- **Real horizontal overflow (~24px):** a photo-upload/CTA button row above the Baseline Score box had no `flex-wrap`, so at mobile width its contents couldn't fit on one line and forced the whole card wider than the viewport. Fixed by allowing the row to wrap and stack cleanly on mobile.
- **A chart-canvas sizing artifact** initially suspected as a second contributor turned out to be a stale measurement — once the button-row fix landed and the page had a normal render cycle, the chart correctly resized on its own with no separate fix needed.
- **The 4-column mini-layout itself** wasn't clipping or broken, just visibly cramped (34-41px columns). Restructured so "Baseline Score" becomes its own full-width row on mobile specifically, with Current Streak/Best Streak auto-flowing below it — all four columns now render at an even 66px with zero page overflow. Desktop confirmed completely unaffected (re-tested, unchanged).

All measurements taken empirically at a real 375px viewport, not eyeballed — including deliberately isolating and toggling individual elements to trace the true root cause before proposing a fix.

**Supporting services/tools:** `server.js`, Claude Code

### Four real dashboard bugs found and fixed, from direct visual review

Reviewing a live dashboard via the newly-connected phone-to-PC setup (Phone Link) surfaced four issues:

- **Full vet disclaimer was missing from the main dashboard.** It existed inside the hidden Journey Summary modal and on the breed guide page, but never on the dashboard's own default, immediately-visible content. Added, matching the existing muted-text pattern.
- **"Held steady" false-trend bug** — during the baseline-only period (zero real check-ins yet), the dashboard was comparing a dog's baseline score to itself and confidently reporting "held steady," a false claim with nothing real to compare against. Root-caused to the score-fallback logic (not the display function), fixed to show honest baseline-only copy instead: "Baseline recorded — first weekly update will show your dog's trend."
- **Current Streak box had a visible empty area**, caused by a CSS Grid `stretch` quirk (it shares a row with the taller Baseline Score box). Filled with real contextual copy instead of leaving it blank: "Complete your first check-in to start a streak" or "Keep it going!" depending on streak state.
- **"Notes:" relabeled to "Baseline Notes:"** to distinguish the one-time signup observation field from the separate ongoing mid-week notes feature.

**Supporting services/tools:** `server.js`

### Real, live bug found: churn-detection email firing during the baseline period

While reviewing a real welcome/reminder text thread on the newly-connected phone, spotted a "we noticed we haven't heard from you" re-engagement email that had fired for a dog still inside its 7-day baseline period — before a first check-in was even possible. Investigation confirmed the churn-detection cron had no baseline-period check anywhere, unlike the check-in submission routes which already gate on this correctly. Fixed by adding the same gate; verified live (under `TZ=UTC`, matching production) across dozens of accelerated cron cycles that a baseline-period dog is now silently skipped, while a genuinely overdue dog still correctly receives the email.

**A real testing snag worth remembering:** the first verification attempt appeared to show the fix failing, traced to the local dev machine's timezone (CDT/UTC-5) causing Supabase's timezone-suffix-less timestamps to parse incorrectly — resolved by running the local test server with `TZ=UTC`, matching how production actually runs. Not a flaw in the fix itself.

### Churn-detection logic consolidated into one shared function

Discovered a second, fully separate copy of the churn-detection logic existed at a manual test endpoint (`/api/test-churn-detection`) — meaning the baseline-period fix above only applied to the real cron, not this duplicate, which would have silently drifted back out of sync. Refactored both call sites to use one shared function (`processDogForChurn`), with real behavioral differences (SMS-sending vs. not, real owner vs. test email) preserved explicitly via parameters rather than lost in the merge. Independently verified both entry points against both scenarios (baseline dog, overdue dog) before committing.

### Silent email-failure logging gap found and fixed

While verifying the refactor, discovered SendGrid was returning real `403 Forbidden` errors (see below) — and that a failed send was still being logged as a false "✅ sent," with a `churn_flags` dedup row still written, meaning a real failed email would silently block any retry for 24 hours while claiming success. Fixed to log failures honestly and skip writing the dedup record on failure, verified live against SendGrid's actual, currently-failing state — confirming both the failure path (logs correctly, no false dedup) and the success path (unchanged, still works) behave correctly.

**Supporting services/tools:** `server.js`, SendGrid, Supabase (`churn_flags`)

### Full message-content dry-run audit — no real sends, no cost, no rate-limit risk

John initially wanted a full 12-week compressed live test (all real SMS/email sends) to see the entire logger journey end to end. Investigated first and found two real reasons not to run it live: SendGrid was confirmed to be a free-tier account already at its 100-email/day hard cap from testing volume that day (querying SendGrid's account API directly, read-only, no email sent to check), and the reminder/churn-email relationship turned out to be more complex than a clean sequence (the churn email has no time gate and can fire before any SMS reminder, depending on cron timing) — meaning a compressed live test would have produced a confusing, hard-to-interpret pile of messages rather than a clean walkthrough.

Instead, built a complete **dry-run trace**: read every real message template directly from the source code and rendered the exact text a logger would see, for two full 12-week scenarios (on-time logging, and missing every single week), entirely offline — zero Twilio or SendGrid calls made. This is now saved as its own reference document, **`All_SMS_Communications.md`**.

**The dry-run surfaced real bugs that hadn't been caught any other way:**

- **The churn email always cited the dog's original signup date**, verbatim, forever — a dog that had never checked in would still see "we haven't heard from you since [day-1 date]" in week 13 as much as week 2. Fixed: when no real check-in exists, the email no longer names a specific stale date at all.
- **The churn email could fire before the first friendly reminder SMS**, since it has no time gate of its own. Fixed: it now only fires after Reminder #1's 2:00 PM trigger has passed that week.
- **Two real grammar errors** in the churn email body ("helps build information with the intentions to..." and "...all pets families participating") — both corrected.
- **Weight and cognitive data, collected every 4th week, was never acknowledged back to the user** — the confirmation banner looked identical regardless of whether the extra questions were answered. Added a short confirming line specifically for those weeks.
- **A second, fully dead duplicate reminder/SMS system was discovered** (`/api/checkin`, a `survey_weekly_checkins` table, its own separate wording) — confirmed genuinely unreachable, since the real check-in page posts to a different route entirely. Not fixed, flagged as a real cleanup candidate.
- **Milestone messages land on weeks 3, 5, 9, and 13, not the "2/4/8/12" framing** one might assume from a "12-week program" — a real, internally-consistent effect of the streak counter starting at the first actual submission (week 2 is the first possible check-in; week 1 is baseline-only). Not a bug, but worth knowing if any future marketing/beta copy references specific milestone weeks.

**Supporting services/tools:** `server.js`, Claude Code (offline code tracing, no network calls)

### Real SMS segment-length bug found and fixed

Prompted by a direct question — "is there a 160-character limit before messages split?" — audited every real SMS template using real production values (full domain, real 64-char tokens, real 36-char dog UUIDs, both a short and a long test dog name). Found **3 of the 5 SMS templates were already splitting into 2 segments in production** — real, ongoing per-send cost, not just a style concern. All confirmed pure GSM-7 (no emoji/em-dashes), so the 160-character single-segment limit applied cleanly once trimmed.

Trimmed four of the five templates (Reminder #1 already fit and was left unchanged) to comfortably clear 160 characters even at the longer test name. One real gotcha caught mid-fix: an early trimmed draft used an em dash for style, which alone forces UCS-2 encoding and drops the limit to 70 characters — making the "fix" worse than the original. Confirmed all final copy uses plain ASCII punctuation only.

Also added a **40-character maximum length on `dog_name`**, both client-side (the real signup form) and server-side (reusing the existing name-sanitization helper), specifically so this margin stays structural going forward rather than something a longer real dog name could quietly erode again later. Re-verified all four trimmed templates against the actual post-edit template strings (not the earlier draft copy) before committing.

**Supporting services/tools:** `server.js`, `baseline-health-journey.html`, Claude Code

### Full test data wipe

At John's request, fully wiped all 9 test dogs and every related row across `mobility_checkins`, `dog_notes`, `health_alerts`, `sms_queue`, `magic_link_tokens`, and `churn_flags` (a table missed in the original audit, caught mid-delete via a foreign-key constraint, confirmed and included). All 7 tables verified at 0 rows afterward. Google Sheets data rows (Signups, CheckIns, Notes tabs) cleared separately, headers preserved. Purpose: give SMS/notification timing testing a genuinely clean baseline, since accumulated test data from prior sessions made it unclear which alerts were current vs. stale.

**Note:** the orphaned `users` legacy table was not part of this wipe (no foreign-key link to `senior_dogs`, so it wasn't discovered by the same table-enumeration process) — still a separate, known loose end.

### Phone linked to PC for real-time testing visibility

Set up Microsoft Phone Link (iPhone) so real SMS and notifications appear directly on the PC screen during testing, rather than requiring a phone-to-desktop screenshot round-trip. This is what allowed the direct visual review that caught several of this session's bugs (the missing disclaimer, "held steady," the streak box, and the baseline-period churn email) in the first place.

### New reference document created

**`All_SMS_Communications.md`** — full record of all five real SMS templates: final copy (post-fix), exact character/segment counts against both a short and long dog name, trigger conditions, and the technical background on GSM-7/UCS-2 encoding limits. Intended as a standing reference, updated going forward whenever SMS copy changes.

### Dashboard visual polish: unified card system, and the Journey Summary made to feel like a real document

John flagged that the dashboard and the Journey Summary printout both had an "unfinished" feel — not a specific bug, a design gap. Investigation confirmed a real, concrete cause rather than vague inconsistency: two competing card-styling systems were in use simultaneously — larger cards (the header, Health Journey card, "at a glance" panel) used shadow-only elevation with no visible border, while smaller boxes (Baseline Score, streak boxes) used a border so pale it was barely distinguishable from the background, with no shadow at all. Neither system alone was wrong, but running both side by side is what reads as unpolished.

**Fixed with one unified card system, applied consistently across every card on the dashboard** (including `.baseline-notes`, added to the pass after review flagged it as an unnecessary exception): a real, visible border color, a consistent soft shadow for genuine elevation, and one consistent border-radius everywhere. Also cleaned up a photo-upload control row that had three visually mismatched elements (native file input, styled button, status pill) crammed together, restyled to read as one coherent row.

**The Journey Summary printout got the same treatment plus document-specific touches:** a full frame border around the whole printed page (not just internal sections), a letterhead-style rule under the header block, real section dividers between Trends/Weekly Log/Notes, and the "Prepared on [date]" line restyled as small-caps document metadata instead of a casual timestamp. The full vet disclaimer was confirmed already correctly present and correctly surviving print (verified via the actual DOM structure and the print CSS rules, not assumed).

**A second real, live bug found in the course of this work, same family as the original "Week #0" fix:** the Journey Summary was showing "Week -1 of 12" for a genuinely fresh test dog. Investigation (correctly re-checked under matching production timezone conditions before concluding anything) found this specific call site was missing the `Math.max(0, ...)` floor guard that a neighboring, nearly-identical calculation two lines above it already had — confirming the original multi-site "Week #0" fix from earlier in the week hadn't been applied everywhere it needed to be. Fixed and verified.

**Supporting services/tools:** `server.js`, Claude Code

### Journey Summary print bugs found and fixed through direct real-world testing

John began testing the actual printed/PDF output directly (not just on-screen), which surfaced three further real, separate bugs — each found and fixed in its own round, all confirmed against real generated PDFs rather than assumptions:

- **The printout was generating 3 duplicate pages instead of 1.** Root cause: the print CSS hid the rest of the page using `visibility: hidden`, which hides content visually but preserves its full layout height — so the browser still generated enough physical pages to cover that invisible height, with the print area repeating across all of them. Fixed by switching to a `display: none`-based hiding approach, which actually removes hidden content from the page-flow calculation. Verified via direct DOM height measurements (the local browser tooling couldn't drive the native print dialog directly) before and after the fix.
- **No real chart existed in the printout at all** — only text-based trend lines. Since this is meant to be a serious, retention-driving artifact a real owner might bring to a vet, added an actual chart image, generated by capturing the dashboard's existing live Chart.js canvas to a static image (`canvas.toDataURL()`) rather than building and maintaining a second chart. A muted note beneath it was added, per John's direction, explaining that the chart will contain more information as real weekly updates accumulate — worded carefully after review to avoid overpromising a weight series the chart structurally can't hold (weight uses a different scale than the 1-8 mobility/energy/appetite axis).
- **Adding the chart pushed a typical baseline-only summary to 2 pages**, with the page break landing awkwardly right after "Notes," stranding the disclaimer alone on a near-empty second page. Fixed two ways: tightened spacing across every section to fit the common case back on one page (verified with real, corrected viewport-width measurements after an initial measurement attempt was caught and redone at a realistic desktop width rather than an accidentally narrow test window), and added `break-inside: avoid` to every major section as a permanent safety net — so a longer, genuinely multi-page record (e.g. a full 12 weeks of real check-ins) will still break cleanly between sections rather than mid-content, even though it will legitimately need more than one page.
- **A final usability gap found through John's own direct testing:** the chart was only being generated at the moment the Print button was clicked, meaning the on-screen modal never showed it — what John saw before printing didn't match what actually printed. Fixed by moving the chart capture to fire when the modal opens instead, so the on-screen view and the printed output are now guaranteed to always match.

**Four leftover test notes**, found incidentally while diagnosing a print-height discrepancy during this work, were confirmed as this session's own test residue and cleaned up.

Final state confirmed against a real generated PDF: one page for the baseline-only case, real chart with legend, all styling intact, disclaimer present, on-screen view matching the printed output exactly.

**Supporting services/tools:** `server.js`, Claude Code, Chart.js (canvas-to-image capture)

---

- **Lawyer review** — still not yet scheduled; full question list remains in `CompanionCommons_Strategy_and_Legal_Aug20.md`.
- **Deciding when to actually open the site (`SITE_PASSWORD`)** — still genuinely just a decision.
- **STEP P1C (Comparative Feedback)** — still blocked on real breed-cohort volume.
- **STEP P8 (full end-to-end pass)** — still outstanding.
- ~~Missing consent record~~ — **fixed Aug 22** (`consent_given_at` on both `magic_link_tokens` and `senior_dogs`, see Session 2 entry below).
- ~~Orphaned `users` table~~ — **fixed Aug 22**, and taken further than originally scoped: the entire dead legacy schema (`users`/`pets`/`survey_baselines`/`survey_weekly_checkins`/`survey_enrichment`/`sms_preferences`) is now dropped, not just this one table.
- ~~Stored-XSS gap in the Journey Summary modal~~ — **fixed Aug 22**, as part of a full site-wide sweep, not a one-off patch.
- ~~Site-wide audit needed: unescaped user-controlled fields rendered into HTML without `escapeHtml()`~~ — **done Aug 22**, see Session 2 entry below for the two real findings it turned up.
- **Data-model separation (identifiable vs. de-identifiable fields)** — not yet started.
- ~~Dead duplicate reminder system (`/api/checkin`, `survey_weekly_checkins`)~~ — **removed Aug 22**, along with `/api/enrichment`, both confirmed to have zero live callers first.
- **Startup log message says "(1 minute for testing)"** for the churn cron, but the real interval is 60 minutes — cosmetic, pre-existing, still not fixed.
- **Begin actual beta recruiting** — 8 real strangers + 2-3 known friends, per the Aug 20 decision — not yet started.

---

## August 22, 2026 — Stray Local Dev Server Racing Live Supabase Data, and the Multi-Dog Owner Project Closes Out

### A real testing lesson: a stray local `node server.js` process raced a fresh test run against live data

While live-verifying Stage 4's SMS-combining feature (see `Multi_Dog_Signup_Build.md`), the first attempt looked like a failure: two dogs under one owner, both due for the same reminder, went out as two separate texts with two different Twilio message SIDs and their original individual wording — not combined at all. The grouping logic itself checked out correct both in isolation and re-tested directly against live Supabase data, which pointed away from a code bug. The actual cause: a stray `node server.js` process left running from earlier local work was still alive, polling the same live `sms_queue` table on its own 60-second timer, running older code. It raced the fresh test server — each process grabbed one of the two queued rows before the other could group them, so both got sent individually, one from each process's own (different) logic.

A full process sweep (`Get-Process node | Stop-Process -Force`, confirmed zero `node.exe` running) followed by one clean server instance produced the correct result on retest. **This is now a standing rule in `CLAUDE.md`**: check for and kill any existing node processes before starting a local dev server for testing, since a stray leftover server shares the same live Supabase database as a fresh test run and can silently race it, producing a false-looking failure.

### Multi-Dog Owner Project — Complete (Aug 22)

The multi-dog owner architecture project (owner entity, `owners` table, signup rewrite with returning-owner detection, message consolidation, and an additive-only dashboard dog-switcher) is now fully complete across all 5 stages. Full design decisions, investigation findings, and live verification detail for every stage live in `Multi_Dog_Signup_Build.md` — not duplicated here, consistent with that doc's original scope.

---

## August 22, 2026 (Session 2) — Consent Record, Site-Wide XSS Sweep, Legacy Schema Removed

Closes out three of the real gaps the Aug 20 privacy audit surfaced, plus the dead-code cleanup flagged alongside them — commit `102798a`.

**Consent record, finally persisted.** The signup consent checkbox has always blocked submission if unchecked, but the fact that consent happened was never actually stored anywhere. Added `consent_given_at` to both `magic_link_tokens` (captured at submission, carried through to `/verify` the same way `contact_preference`/`owner_name` already were) and `senior_dogs` (the real persisted record, written on all three dog-creation paths — `/verify` for both new and returning owners, and `/api/add-dog`). Migration run, verified with a real end-to-end signup.

**A full site-wide `escapeHtml()` sweep**, not another one-off patch — the Journey Summary notes gap flagged since Aug 20 was the trigger, but the sweep covered every `dog_name`/`breed`/`note_text`/`baseline_notes` interpolation across the check-in page, breed guide, dashboard, Journey Summary, the `/checkins/:owner_id` page, and both churn alert emails. Two real findings turned up beyond the original checklist: `activeAlert.message` (the health-alert banner, unescaped on both the dashboard and Journey Summary) and `dog.baseline_notes` — the actually-exploitable one, since it's sanitized at input only via `sanitizeString()` (trim + length cap), unlike `dog_name`/`breed`, which go through the much stricter `sanitizeName()` (letters/spaces/hyphens/apostrophes only — meaning those two fields were never really exploitable; escaping them was real defense-in-depth, not closing a live hole). Verified empirically, not just by inspection: a test dog was created with actual `<script>`/`<img onerror>`/`<svg onload>` payloads written directly into the database, bypassing the app's own sanitization entirely, and confirmed to render as inert text on every page checked.

**The entire dead legacy schema — `users`, `pets`, `survey_baselines`, `survey_weekly_checkins`, `survey_enrichment`, `sms_preferences` — is now actually dropped**, not just orphaned. Before dropping `users`, `sms_queue.user_id` (a dead foreign key nothing in the real app ever populated) had to be explicitly cleaned up first, since Postgres won't drop a table another column still references. Confirmed live afterward: querying any of the six tables now returns "could not find the table," not just empty results. On the code side: deleted the broken duplicate `users` insert inside `/verify` (a schema mismatch that had been silently failing on every single signup since the project began), and removed the `/api/checkin` and `/api/enrichment` routes outright after confirming zero live callers in `Public/` — `/api/checkin` turned out to reference an undefined variable in its SMS body, proof it had never actually been exercised. The `opted_out` branch in `/api/sms/mark-failed` was also removed on the same confirmed-zero-callers basis.

Test data (including Storage) wiped afterward. Closes checklist items 2, 8, 9, and 11.
