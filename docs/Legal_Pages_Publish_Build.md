# CompanionCommons — Legal Pages Publish Build
**Started:** September 3, 2026
**Status:** Phase 2 (implementation) complete and live on production. Phase 3 (FAQ verbiage pass) is investigation-only — findings below, no content changed on `faqs.html` yet.
**Purpose:** Standalone tracking document for replacing the live `Public/privacy.html` and `Public/terms.html` content with the reviewed rewrite drafts in `docs/LEGAL-DRAFTS/`. Tracked separately from the main build log given the scope, matching the pattern set by `Multi_Dog_Signup_Build.md`, `Health_Instrument_Redesign_Build.md`, and `Link_Revocation_Build.md`.

---

## Investigation findings (Phase 1 — Sept 3, 2026)

### 1. Live schema — queried directly via Supabase (PostgREST introspection), not inferred

**`owners` table:** `id`, `email`, `phone`, `preferred_contact_method`, `zip_code`, `preferred_reminder_day`, `preferred_reminder_time`, `created_at`, `name`, `email_opt_out`, `access_token`.
**No consent-timestamp or policy-version column exists on `owners`, under any name.**

**`senior_dogs` table (37 columns):** includes `consent_given_at` (timestamp without time zone) and `consent_policy_version` (text). **Both already exist.**

**`magic_link_tokens` table:** also has `consent_given_at` and `consent_policy_version` (the staging copy, written before a real dog row exists — same staging pattern used for every other baseline field on this table).

### ⚠️ Major finding: the legal drafts' own stated premise is stale

Both `docs/LEGAL-DRAFTS/Privacy_Policy_Draft.md` (Section 10, "Consent") and `Privacy_Terms_Rewrite_Outline (1).md` ("Summary of Real Open Items," item 1: *"🔴 Persist a real consent record at signup... a pre-existing, still-unfixed gap from the Aug 20 privacy audit"*) describe persisting a consent record as something that **still needs to be built**.

**This is no longer true.** Per `CompanionCommons_Build_Log.md`'s Aug 22 Session 2 entry ("Consent record, finally persisted") and the Sep 2 doc-sync audit, `consent_given_at` was added to both `magic_link_tokens` and `senior_dogs` back on Aug 22, and `consent_policy_version` was added alongside it on Sep 2 (`CURRENT_CONSENT_POLICY_VERSION` in `server.js`, currently `'2026-09-01'`). This investigation confirms both columns are live, populated on every real signup path, and have been for some time — not a gap, a shipped feature.

**Confirmed via direct code read of both write sites** (not just the schema): `/api/send-magic-link` (`server.js:7373`, `7386`) requires `consent` truthy in the request body before proceeding, then stages `consent_given_at: new Date().toISOString()` and `consent_policy_version: CURRENT_CONSENT_POLICY_VERSION` on the `magic_link_tokens` insert (`server.js:7665-7666`). `/verify` copies both fields from `tokenData` onto the real `senior_dogs` row (previously confirmed at `server.js:8072-8073`). `POST /api/add-dog` (the "Add Another Dog" path, which creates a `senior_dogs` row directly with no token-staging step) independently requires `consent` truthy (`server.js:8270`) and writes `consent_given_at: now` / `consent_policy_version: CURRENT_CONSENT_POLICY_VERSION` directly (`server.js:8433-8434`). All three write sites use the same `CURRENT_CONSENT_POLICY_VERSION` constant — no drift risk between them.

**What this means for scope:** the rewrite's Section 10 language should describe an **existing, already-built mechanism accurately** ("we record the date and time you gave consent, and which version of this policy was in effect" — true today), not a promise of future work. The outline's "Real Open Item #1" should be struck or re-labeled as already resolved, not left as an active blocker for this publish work. This changes what "publish the legal pages" actually requires — it's a content/copy replacement on top of a system that's already sound, not a combined content-and-backend build.

**One real, still-open gap, worth flagging separately since it's adjacent but distinct:** `owners` itself has no consent record — by design, since consent is captured per-dog (`senior_dogs`/`magic_link_tokens`), not per-owner, matching this project's existing "consent is a per-dog thing" convention (see the checkbox's own code comment, item 2 below). This is consistent with how the app already works elsewhere (e.g. `sms_consent` also lives on `senior_dogs`, not `owners`) — not a new gap this investigation is surfacing, just noting it for completeness since the schema check was scoped to both tables.

### 2. Current signup consent checkbox

**File:** `Public/baseline-health-journey.html`, lines 588-605.

```html
<!-- Consent (per-dog — Phase B) -->
<fieldset>
  <div class="form-group">
    <label style="display: flex; align-items: flex-start; gap: 8px;">
      <input
        type="checkbox"
        id="consent"
        name="consent"
        required
        style="margin-top: 4px;"
      />
      <span>
        I understand my observations help build a trusted pet health community.
        I consent to participate. *
      </span>
    </label>
  </div>
</fieldset>
```

**Current behavior:** plain HTML5 `required` attribute — browser-native validation only, blocks form submission client-side if unchecked. No JS-driven logic beyond that. The code comment explicitly tags this "per-dog," matching the schema finding above (consent lives on `senior_dogs`/`magic_link_tokens`, not `owners`).

**Server-side, confirmed by code read (not assumed from the client-side attribute alone):** the checkbox's value flows through as the `consent` field in the POST body. `/api/send-magic-link` (`server.js:7386`) and `/api/add-dog` (`server.js:8270`) both independently reject the request with a 400 if `consent` is falsy — the `required` attribute is a UX convenience, not the real gate, consistent with this project's standing pattern of never trusting client-side validation alone (same pattern already documented for the medication/score-widget validation work). Once past that gate, the *fact* of consent is what gets persisted (a timestamp + policy version), not the raw boolean itself — no `consent` column exists on either table; existence of a `consent_given_at` value on a real row is the durable record.

**What this means for the rewrite:** the checkbox's own label text ("I understand my observations help build a trusted pet health community. I consent to participate.") is generic — it doesn't reference "this policy" or a specific version, and isn't itself hyperlinked to the Privacy Policy/Terms. If the rewrite wants to strengthen this (e.g., "I have read and agree to the [Privacy Policy] and [Terms of Service]"), that's a real, separate content change to `baseline-health-journey.html`, not just the two legal pages — flagging it here since it's directly relevant to whether the consent record can honestly claim what policy the user agreed to. Not yet decided; a scope question for the next step, not something already answered by this investigation.

### 3. Current live `privacy.html` and `terms.html` — full content and structure

**These two pages use two different structural templates from each other** — a real design decision the rewrite needs to resolve, not something to gloss over.

**`Public/privacy.html`** — uses the site's standard marketing-page template: `.page-hero` (hero band) → alternating `.content-section` / `.content-section alt` blocks → `.content-grid` of `.content-card` (3-column card layout) for grouped content (e.g. "How we use your data," "Research & data partnerships" are each rendered as 3-card grids). No custom `<style>` block — relies entirely on the shared `assets/css/styles.css`. Sections, in order: Our core promise → What we collect / What we do NOT collect → How we protect it (encryption / access control / deletion, as cards) → How we use your data (3-card grid) → Research & data partnerships (3-card grid) → Your rights (who can use, access/export/delete, communication controls, questions). Standard site footer (brand mark, tagline, link to `terms.html`, Contact Us link, veterinary disclaimer block) — same footer used site-wide.

**`Public/terms.html`** — uses a **custom, denser legal-document template**, not the card-grid pattern. Has its own `<style>` block (lines 19-29):
```css
.legal-content { max-width: 760px; margin: 0 auto; }
.legal-content h2 { margin-top: 32px; }
.legal-content .highlight { background: #F0F9F7; border-left: 4px solid #3E8278; padding: 16px; margin: 20px 0; border-radius: 4px; }
```
17 numbered sections in a single narrow column (Eligibility, Our service, Pet health data collection [uses `.highlight` box], SMS communication, User responsibilities, Intellectual property, Limitation of liability [uses `.highlight` box for the Medical Disclaimer], Warranty disclaimer, Data retention & deletion, Privacy, Changes to terms, Termination, Governing law, Dispute resolution, Severability, Contact us, Acknowledgment). Same site header/footer as every other page, but the `<main>` content itself is structurally unrelated to `privacy.html`'s card-based layout.

**Decision needed before the rewrite lands (not resolved by this investigation):** should both pages converge on one shared template (and if so, which — the card-grid or the dense-numbered-list-with-highlight-boxes), or is it acceptable/intentional for Privacy to stay card-based (skimmable, consumer-facing) while Terms stays a dense reference document (the way many real sites split these two registers)? Worth deciding explicitly rather than defaulting either way.

### 4. Exact locations: "Effective Date" and contact email in both live files

| | `privacy.html` | `terms.html` |
|---|---|---|
| **Date line** | `Last updated: August 16, 2026` — line 60, inline-styled text inside `.page-hero`, no semantic "Effective Date" label used | `Last updated: August 16, 2026` — line 64, same inline pattern |
| **Contact email** | Line 193 — `Email us at <strong>hello@companioncommons.com</strong>` — **plain bold text, not a link** | Line 167 — `Email <a href="mailto:hello@companioncommons.com">hello@companioncommons.com</a>` — **a real mailto link** |
| **Copyright/footer line** | Standard site footer only, no separate copyright line | Lines 172-174: `© 2026 Companion Commons. All rights reserved.` — a line with no equivalent on `privacy.html` |
| **Governing law** | N/A (not a Privacy Policy topic on this site) | Section 13: `"These Terms are governed by the laws of the **United States**"` — a general choice-of-law clause, not a specific state |

**Discrepancies against the drafts, worth flagging now rather than discovering mid-rewrite:**
- Both live pages currently use the identical "Last updated: August 16, 2026" date — the rewrite drafts are dated Sep 2, 2026 and marked "DRAFT — requires attorney review." Whatever date actually goes live needs to be a real decision (today's date, the date of attorney sign-off, or some other convention), not copy-pasted from the draft docs' own header date.
- `privacy.html`'s contact email is plain text, not a mailto link — `terms.html`'s is. If the rewrite is meant to be consistent across both pages, this small inconsistency should be resolved (recommend: make both real mailto links, matching the working `hello@companioncommons.com` forward already confirmed live per the Build Log).
- The Terms draft (per the earlier full-text read) specifies **"State of Texas"** governing law — the current live Terms says only **"United States"** with no specific state named. This is a real, substantive legal change (not a copy tweak) and should be called out explicitly to John/counsel as a deliberate choice being made, not quietly swapped in.
- `terms.html` has a standalone copyright line with no equivalent on `privacy.html` — worth deciding whether `privacy.html` should get one too for consistency, or whether that's deliberately Terms-only.

---

## Next step

Per instruction, no schema or code changes are authorized yet. This document captures Phase 1's findings for review. The most consequential finding is the stale-premise correction: the consent-record mechanism the drafts describe as future work is already live and correct — the actual rewrite work is a content/copy replacement (plus a template-consistency decision between the two pages), not a combined content-and-backend build.

---

## Phase 2 — Implementation (Sept 3, 2026)

Confirmed decisions before starting: governing law kept as drafted (Texas — confirmed factually correct); `privacy.html` converted to `terms.html`'s existing dense numbered-section template (not the other way around).

**`privacy.html` / `terms.html`:** full 14-section body of each replaced verbatim with the corresponding draft's content (DRAFT banner and Open Placeholders footer stripped from both). `privacy.html` rebuilt onto `terms.html`'s `.legal-content`/`.highlight` template — added the shared `<style>` block, replaced the card-grid `<main>` with one dense `.legal-content` container. `terms.html`'s own template was untouched. Both "Last updated" dates → September 2, 2026. `privacy.html`'s contact email converted to a real `mailto:` link, matching `terms.html`'s existing pattern. The new Terms §4 ("No Medical Advice") uses the page's existing `.highlight` box treatment, mirroring where the old page highlighted its Medical Disclaimer — the only place in either draft that maps cleanly onto that visual pattern.

**Consistency checks (all passed, no fixes needed):** jurisdiction language between Privacy §1 and Terms §3 doesn't drift; every internal same-page section cross-reference in the Privacy draft (§4→§8, §4→§6, §9→§11, §10→§6, §11→§9, §11→§8) checked against the numbering actually shipped (unchanged 1–14, no reordering) — all correct; grepped the rest of the site and `server.js` for any hardcoded `terms.html#`/`privacy.html#` anchor or "Section N of..." reference — none exist.

**Consent checkbox strengthened**, both signup surfaces (`baseline-health-journey.html` and `add-dog.html`, kept byte-identical to each other): label now reads "I agree to the [Privacy Policy] and [Terms of Service]. I understand my observations help build a trusted pet health community, and I consent to participate." Both links `target="_blank" rel="noopener"`. `CURRENT_CONSENT_POLICY_VERSION`/`consent_given_at` capture logic untouched — out of scope, already correct per the Phase 1 finding above.

**A real bug found and fixed during manual (non-sandbox) browser testing, not caught by the initial DOM-attribute-only verification pass:** John reported that clicking "Privacy Policy" on the consent checkbox discarded the in-progress signup form and landed on `trust-and-data.html` instead of `privacy.html`. Investigated rather than guessed at a fix — confirmed via `curl` against the real running server that the served HTML matched the repo exactly (no template drift), confirmed no click handler in `main.js` or anywhere else touches this link, then directly reproduced the exact symptom by clicking a *different*, pre-existing link 176px below the checkbox — the "Learn more." caption under the submit button (`Your information is encrypted and never sold. Learn more.`), which had `href="trust-and-data.html"` and no `target` attribute at all. A second, similar pre-existing link ("See our Terms & Privacy") near the SMS contact-preference field had the same issue. The actual "Privacy Policy" link built for this task was confirmed correct throughout — never the real bug.

**Both pre-existing links fixed:** "See our Terms & Privacy" split into two separately-linked words (`Terms` → `terms.html`, `Privacy` → `privacy.html`), both `target="_blank" rel="noopener"`. "Learn more." repointed from `trust-and-data.html` to `privacy.html` (contextually correct — the sentence is about data handling), same target/rel treatment. Re-verified with real coordinate clicks against the actual running server (not just DOM inspection) — confirmed via `document.title`/`location.href` after each click that all three links (Terms, Privacy, Learn more.) now land on the correct real page.

**Standing caveat, not a page bug:** in the sandboxed browser-pane test environment used for this verification, `target="_blank"` links consistently navigate the same tab instead of opening a new one — confirmed this is an environment restriction, not a markup defect, by separately observing a scripted `window.open()` call return `null` (blocked) in the same environment. All affected links carry correct `target="_blank" rel="noopener"` markup regardless.

### Follow-on, not fixed this pass: `faqs.html`'s privacy section reads stale against the new Privacy Policy content

Found while looking for anything else referencing legal-page content that might now be inconsistent (not part of the original task scope — flagged, not touched). `Public/faqs.html`'s "02 — Your privacy" section (`#f6`, "What information do you collect?") currently says:

> "Your notes are stored, but only as a method to populate your dashboard. **We do not use notes for any intelligence at this time.**"

The new `privacy.html` §5 states this as a permanent, architecturally-enforced rule ("never included in any aggregate dataset, licensed dataset, or export of any kind... enforced directly in how our systems are built"), not a "not yet" — the FAQ's "at this time" phrasing now undersells and slightly misrepresents a stronger real commitment. The same FAQ answer also lists a narrower set of collected fields (name, age, breed, gender, baseline/weekly answers) than the new Privacy Policy §2 actually discloses (zip code, phone, email, weight, spay/neuter status, diet type, insurance status, medication category, condition treated). Neither is a compliance-critical gap (the FAQ isn't the legal document, and it doesn't contradict the new pages so much as understate them) but it's a real, findable inconsistency now that the two real legal pages are live and specific. No date/jurisdiction language exists on `faqs.html` to check for drift. Recommend a follow-up pass to align `#f6`'s wording with the new Privacy Policy — not scoped or done as part of this task.

---

## Phase 3 — FAQ verbiage pass (Sept 3, 2026) — investigation only, no content changed

Full current content of `Public/faqs.html` read in full (21 FAQ entries across 6 groups, plus a Communication Promise block and footer). Every entry touching data sharing/licensing, who CompanionCommons shares with, consent, retention, account/link access, opt-out, medical/diagnostic disclaimers, and governing law/jurisdiction was cross-checked line-by-line against the actual live `privacy.html`/`terms.html` content (the same text committed and verified live on production earlier this session, not the drafts). `faqs.html` itself is untouched — findings only.

### Clean — no discrepancy found

- **`#f19` "Is this a veterinary service?"** — matches Terms §2/§4 almost verbatim (same standing vet-disclaimer language already used site-wide in the footer). **PASS.**
- **`#f16` "What is aggregated and de-identified data?"** — illustrative example, consistent with Privacy §6/§7, not a factual claim requiring precision. **PASS.**
- **`#f20` "Do you sell pet products?"** — consistent with Privacy §4/§6's no-advertising, no-product-promotion commitment. **PASS.**
- **Governing law / jurisdiction** — `faqs.html` makes zero jurisdiction, governing-law, or "United States residents only" claims anywhere on the page (confirmed via grep for "governed by", "United States", "resident", "Effective", date strings — no matches). Nothing to contradict Terms §3/§13's US-residency requirement or the Texas governing-law clause. **PASS by absence**, not by an accurate statement — if a jurisdiction claim is ever added to the FAQ, it needs to match Terms §3/§13.
- **Footer legal-page links** (lines 510, 513, 515) — `trust-and-data.html`, `privacy.html`, `terms.html` — all three point to the correct, currently-live pages. **PASS.**

### Real discrepancies found, none fixed yet

**1. `#f6` "What information do you collect?" — HIGH.** Already flagged above (Sept 3 follow-on note). Restated here as part of the full pass: the "we do not use notes for any intelligence **at this time**" phrasing understates Privacy §5's permanent, architecturally-enforced exclusion, and the listed field set (name, age, breed, gender) omits zip code, phone, email, weight, spay/neuter status, diet type, pet insurance, medication category, and condition treated — all real, disclosed fields per Privacy §2.

**2. `#f5`/`#f7`/`#f18` — the "who do you share with" cluster — HIGH.** None of these three answers discloses that de-identified, aggregated data (and predictive models trained on it) is actively **licensed to named categories of external companies** — pharmaceutical companies, research institutions, supplement companies, pet food and nutrition companies, pet insurance companies, pet product manufacturers, and select retailers (Privacy §6, "What we share") — as CompanionCommons's stated **core business model**, not an incidental use. Instead:
   - `#f5` ("Will you sell my personal information?") answers with "we may use aggregated, de-identified data to understand broader health trends" — reads as internal analysis, not external licensing to for-profit companies.
   - `#f7` ("Who can access my information?") says aggregated data is "used to understand patterns and trends" — same gap.
   - `#f18` ("How does Companion Commons make money?") says "aggregated insights, research, and enterprise licensing" — closer, but doesn't name the licensee categories or mention predictive models (Privacy §6 explicitly: "We license de-identified, aggregated pet health information — **and predictive models trained on that information**").

   None of these is technically false (the FAQ never claims data *isn't* shared externally), but all three are materially vaguer than what the real, now-live policy states plainly and specifically — exactly the "vaguer than the real policy" category flagged in the task.

**3. `#f21` "Am I in a research study?" — MEDIUM.** Says "Your participation is voluntary." Privacy §6 ("Your participation") states participation and licensing consent are **bundled, not separable**: *"If you're unwilling or unable to allow your pet's health information to be licensed, this program can't be offered to you."* A reader could reasonably take "voluntary participation" to mean they can log data without their pet's de-identified information being included in the licensed dataset — the real policy says that's not an option. The FAQ's claim that "your private information is protected with strict confidentiality" is also loose given that de-identified *pet health* information is explicitly licensed out, not kept internal — though this is likely fine if read narrowly as referring to identifying information specifically, which is the FAQ answer's apparent intent.

**4. `#f8` "What happens if I leave?" — MEDIUM.** Correctly describes the *mechanisms* (Reply STOP for SMS, the real unsubscribe link for email, contact us) — all still accurate against Privacy §8 and the real, working email-unsubscribe feature (Sept 1 build). But it never addresses **retention** — Privacy §9 draws a real distinction the FAQ doesn't: identifying information (name/email/phone) can be deleted on request, but *"your pet's already-contributed de-identified information remains part of the aggregate dataset — it simply can no longer be traced back to you."* "Your journey ends when you want it to" could reasonably be read as "everything about my pet goes away," which isn't accurate.

**5. `#f11` "Can I track multiple pets?" — LOW/MEDIUM.** Accurately describes the feature (add-a-dog button, one signup) but says nothing about the **account/link access model** disclosed in Terms §5: CompanionCommons has no passwords — dashboard/check-in links function as the access credential, don't expire, and "anyone who has one can view your account's information or add a pet to it," with an explicit instruction to treat links like a password. Given "account/link access model" was named as one of the categories to check, this is a real omission, not a contradiction.

**6. `#f15` "How is my information used?" — LOW.** References "our Privacy Policy" **by name but not as a link** (`Public/faqs.html:374` — plain text, no `<a href="privacy.html">`), inconsistent with the footer's own linked references to the same page and with `#f8`'s linked "contact us form." Content itself is a fair paraphrase of Privacy §4, not contradicted — this is a missed-link issue (task item 4), not a factual one.

### Item 4 — every `trust-and-data.html`/`privacy.html`/`terms.html` reference on the page

| Line | Text | Target | Correct? |
|---|---|---|---|
| 55 | Nav "Trust & Privacy" | `trust-and-data.html` | ✅ |
| 374 | "our Privacy Policy" (`#f15`) | *plain text, not linked* | ⚠️ should be a real link now that the page is live (see finding 6) |
| 510 | Footer "Trust, Privacy & Independence" | `trust-and-data.html` | ✅ |
| 513 | Footer "Privacy Policy" | `privacy.html` | ✅ |
| 515 | Footer "Terms of Service" | `terms.html` | ✅ |

Every actual `<a>` tag pointing at one of the three pages resolves correctly. The only gap is the one un-linked mention.

### Summary

No `faqs.html` content changed. Six real findings (two HIGH, two MEDIUM, two LOW) — the two HIGH findings (`#f6`'s stale "not at this time" framing plus incomplete field list, and the `#f5`/`#f7`/`#f18` cluster's vague-vs-specific gap on who data is actually licensed to) are the closest analogs to the earlier stale consent-persistence finding: not outright false, but describing a materially softer or less specific reality than what the site now actually, explicitly commits to in writing.
