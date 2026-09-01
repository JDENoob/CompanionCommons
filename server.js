// Force UTC regardless of the host OS's local timezone. Must run before any
// Date parsing happens (Supabase timestamps have no timezone suffix, so
// without this Node parses them in local time). This bug has been
// independently rediscovered and fixed via a local-only .env TZ=UTC override
// at least four times across this project's history because .env is
// git-ignored and doesn't travel with the repo. Setting it here instead means
// every environment (local, Railway, a fresh clone) behaves identically with
// no environment-specific setup required. Production already runs as UTC by
// default (Railway's Linux containers, no TZ env var set) — this makes that
// explicit and portable rather than incidental.
process.env.TZ = 'UTC';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const multer = require('multer');

const app = express();

// Escapes free-typed user text before it's inserted into HTML templates
// (e.g. dog notes), so a note containing < > & etc. can't break the page
// or inject anything.
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Icon+wordmark brand lockup (double-C paw icon + "Companion Commons"),
// shared across every server-rendered surface that needs it (Document
// Library, breed guide, Journey Summary, dashboard) so there's one real
// source instead of a fifth hand-copied instance -- the exact trap this
// project's own header-icon history has already fallen into once.
// Absolute /assets path since these routes live under their own segment
// (/dashboard/:id, /breed-guide/:id), where a relative path would resolve
// against the wrong base.
function buildBrandLockup({ iconPx = 24, fontPx = 14, color = '#2C2C2C', gap = 8 } = {}) {
  return `<span style="display:inline-flex;align-items:center;gap:${gap}px;"><img src="/assets/images/brand/companion-commons-double-c-paw.svg" alt="Companion Commons" width="${iconPx}" height="${iconPx}" style="display:block;flex-shrink:0;" /><span style="font-weight:700;font-size:${fontPx}px;color:${color};">Companion Commons</span></span>`;
}

// Human-readable labels for the coded baseline-survey values (dashboard
// display only — the underlying stored values stay exactly as the signup
// form's allowed lists define them).
const DIET_TYPE_LABELS = {
  dry: 'Dry Food', wet: 'Wet Food', raw: 'Raw Diet',
  prescription: 'Prescription Diet', mixed: 'Mixed Diet', other: 'Other Diet'
};
const TREATMENT_CATEGORY_LABELS = {
  joint_supplement: 'Joint Supplement', nsaid: 'NSAID', steroid: 'Steroid',
  pain_medication: 'Pain Medication', other_prescription: 'Other Prescription',
  other_supplement: 'Other Supplement'
  // 'none' deliberately omitted — handled separately, not shown as a "medication"
};

// ============================================
// STEP P10: HEALTH CHECK-IN INSTRUMENT (v2)
// Full design rationale: docs/CompanionCommons_Health_Instrument_Design.md
//
// Stage 1 of the P10 rebuild — shared config, validation, composite-
// scoring, and a reusable 0-10 tap-button widget generator. Nothing below
// is wired into a live route yet; that's Stage 2 (signup forms) and
// Stage 3 (check-in forms). Building these first, in isolation, is what
// lets four separate surfaces (baseline form, add-dog form, standalone
// check-in page, dashboard check-in modal) share ONE implementation of
// the new instrument instead of a fifth copy-pasted version each — the
// exact trap the OLD 1-8 slider design fell into (four near-identical
// hint-dictionary blocks, three near-identical range-validators).
//
// IMPORTANT sign convention: 0 = normal/no difficulty, 10 = severe/most
// concerning, across EVERY domain — a deliberate reversal from the old
// "higher = better" scale. Anywhere that reads a score and decides
// "up = good" needs its comparison flipped, not just relabeled, once
// Stage 4 rewires the dashboard/insight/alert logic to use this.
// ============================================

const INSTRUMENT_SCALE_MIN = 0;
const INSTRUMENT_SCALE_MAX = 10;

// The locked instrument. Domains with `items` (mobility, cognitive) get a
// composite = average of their 4 items. Domains with `items: null`
// (energy, appetite) are collected as a single 0-10 value directly, no
// averaging.
const HEALTH_INSTRUMENT = {
  mobility: {
    label: 'Mobility',
    cadence: 'weekly',
    compositeColumn: 'mobility_score',
    baselineCompositeColumn: 'baseline_mobility_score',
    items: [
      { key: 'getting_up', label: 'Getting Up', anchorLow: 'No difficulty, gets up right away', anchorHigh: 'Severe difficulty, struggles significantly or needs help' },
      { key: 'stairs', label: 'Stairs', anchorLow: 'No difficulty, moves easily', anchorHigh: 'Severe difficulty, avoids stairs entirely or needs to be carried' },
      { key: 'stiffness_after_rest', label: 'Stiffness After Rest', anchorLow: 'Moves normally right away', anchorHigh: "Remains very stiff even after moving around, doesn't fully loosen up" },
      { key: 'walk_distance', label: 'Walk Distance', anchorLow: 'No limitation, walks normal distances easily', anchorHigh: 'Severe limitation, unable to walk normal distances' }
    ]
  },
  cognitive: {
    label: 'Cognitive',
    cadence: 'every_4th_week',
    compositeColumn: 'cognitive_score',
    baselineCompositeColumn: 'baseline_cognitive_score',
    items: [
      { key: 'orientation', label: 'Orientation', anchorLow: 'Not at all, fully alert and aware', anchorHigh: 'Frequently disoriented or confused' },
      { key: 'memory', label: 'Memory / Recognition', anchorLow: 'No signs of forgetting', anchorHigh: 'Frequent signs of forgetting' },
      { key: 'interest', label: 'Interest / Engagement', anchorLow: 'Normal interest and engagement', anchorHigh: 'Little to no interest, seems withdrawn' },
      { key: 'sleep_wake', label: 'Sleep-Wake Pattern', anchorLow: 'Normal sleep pattern', anchorHigh: 'Significantly disrupted' }
    ]
  },
  energy: {
    label: 'Energy',
    cadence: 'weekly',
    compositeColumn: 'energy_score',
    baselineCompositeColumn: 'baseline_energy_score',
    items: null,
    singleItem: { anchorLow: 'Normal, active energy level', anchorHigh: 'Very low energy, lethargic most or all of the time' }
  },
  appetite: {
    label: 'Appetite',
    cadence: 'weekly',
    compositeColumn: 'appetite_score',
    baselineCompositeColumn: 'baseline_appetite_score',
    items: null,
    singleItem: { anchorLow: 'Normal, healthy appetite', anchorHigh: 'Barely eating or refusing food' }
  }
};

// Builds the DB column name for one item, e.g.
// itemColumnName('mobility', 'stiffness_after_rest') -> 'mobility_stiffness_after_rest',
// or with baseline: true -> 'baseline_mobility_stiffness_after_rest'.
function itemColumnName(domainKey, itemKey, { baseline = false } = {}) {
  return `${baseline ? 'baseline_' : ''}${domainKey}_${itemKey}`;
}

function isValidInstrumentValue(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= INSTRUMENT_SCALE_MIN && n <= INSTRUMENT_SCALE_MAX;
}

// Average of 0-10 item values, rounded to one decimal place. Returns null
// if any item is missing — a composite is only meaningful once every item
// in the domain has a real answer, never a partial average.
function computeCompositeScore(itemValues) {
  if (!Array.isArray(itemValues) || itemValues.length === 0) return null;
  if (itemValues.some(v => !isValidInstrumentValue(v))) return null;
  const sum = itemValues.reduce((total, v) => total + Number(v), 0);
  return Math.round((sum / itemValues.length) * 10) / 10;
}

// Rounds to one decimal place, the same precision composite scores
// themselves already use (see computeCompositeScore above). Needed
// wherever a DIFF between two composite scores gets computed, not just
// the composites themselves — subtracting two already-rounded NUMERIC(3,1)
// values in JS can still produce raw floating-point noise (e.g.
// 1.3 - 1.0 === 0.30000000000000004), which showed up verbatim in
// user-facing text and in a stored health_alerts.magnitude value before
// every diff site below started routing through this. Apply it once,
// right after computing a diff, so the rounded value is used for both the
// sign check and the display — an unrounded near-zero diff (float noise
// around a true 0.0) could otherwise flip a sign check the wrong way too.
function roundToOneDecimal(n) {
  return Math.round(n * 10) / 10;
}

// ---- Shared 0-10 tap-button widget ----
// One generator, used identically by the standalone check-in page and the
// dashboard's inline check-in modal (both server-rendered template
// literals in this file, wired up in Stage 3). The two static signup
// forms (Public/baseline-health-journey.html, Public/add-dog.html) can't
// call this function directly since they're plain files, not routes —
// when Stage 2 rebuilds those forms, copy this exact HTML/CSS/JS shape
// into them so all four surfaces stay in lockstep. If this widget's
// markup ever changes, all four surfaces need the update, not just here.
//
// No `required` attribute on the hidden input — per the HTML spec,
// `required` doesn't apply to type="hidden" inputs, so browsers silently
// ignore it there. That would be misleading (implying protection that
// isn't real) rather than just absent, so it's left off deliberately.
// Real client-side enforcement is formHasAllScoreItemsAnswered() below,
// which Stage 2/3's form submit handlers must call explicitly.
function buildScoreItemWidget(fieldName, label, anchorLow, anchorHigh, currentValue, { hideLabel = false } = {}) {
  const buttons = [];
  for (let v = INSTRUMENT_SCALE_MIN; v <= INSTRUMENT_SCALE_MAX; v++) {
    buttons.push(`<button type="button" class="score-btn" data-value="${v}">${v}</button>`);
  }
  const safeValue = isValidInstrumentValue(currentValue) ? Number(currentValue) : '';
  return `
    <div class="form-group score-item" data-score-item>
      ${hideLabel ? '' : `<label>${escapeHtml(label)}</label>`}
      <div class="score-buttons" role="group" aria-label="${escapeHtml(label)}">
        ${buttons.join('')}
      </div>
      <input type="hidden" name="${escapeHtml(fieldName)}" value="${safeValue}">
      <div class="score-anchor-hint">
        <span class="anchor-low">${escapeHtml(anchorLow)}</span>
        <span class="anchor-high">${escapeHtml(anchorHigh)}</span>
      </div>
    </div>`;
}

// Shared CSS for the widget above — one copy, included once per page.
const SCORE_ITEM_WIDGET_STYLES = `
  .score-item { margin-bottom: 24px; }
  .score-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .score-btn {
    flex: 0 1 auto; min-width: 32px; width: auto; padding: 8px 0; border: 1px solid #ddd;
    border-radius: 6px; background: #fff; color: #333; font-family: inherit; font-size: 14px;
    cursor: pointer; text-align: center;
  }
  .score-btn:hover { border-color: #A89968; }
  .score-btn.selected { background: #A89968; border-color: #A89968; color: #fff; font-weight: 600; }
  .score-anchor-hint {
    display: flex; justify-content: space-between; gap: 12px; margin-top: 6px;
    font-size: 12px; color: #999;
  }
  .score-anchor-hint .anchor-low { text-align: left; }
  .score-anchor-hint .anchor-high { text-align: right; }
  .score-item-error { outline: 2px solid #C0392B; border-radius: 8px; padding: 8px; margin: -8px -8px 16px -8px; }
  .score-item-error-message { color: #C0392B; font-size: 13px; margin-top: 6px; font-weight: 500; }
`;

// Shared behavior for the widget above — one copy, included once per page.
// Generic/data-driven on purpose: reads each widget's own hidden input and
// button set, so it works for any number of score-item widgets on a page
// without a per-metric bespoke listener (unlike the old per-slider hint
// dictionaries it replaces).
//
// Also defines two functions Stage 2/3's form submit handlers must call
// explicitly (formHasAllScoreItemsAnswered, highlightUnansweredScoreItem)
// — see the note on buildScoreItemWidget() above for why this is real
// enforcement and the hidden input's `required` attribute is not. This is
// a UX convenience only: the actual gate against an incomplete submission
// is server-side, in computeCompositeScore() returning null on an
// incomplete item set — Stage 2/3's save endpoints must independently
// reject that, exactly like every other validated field in this app
// already does. A user with JS disabled, or a direct POST bypassing the
// browser entirely, must not be able to save a partial answer.
const SCORE_ITEM_WIDGET_SCRIPT = `
  document.querySelectorAll('[data-score-item]').forEach(function(container) {
    var buttons = container.querySelectorAll('.score-btn');
    var hiddenInput = container.querySelector('input[type=hidden]');
    function selectValue(v) {
      hiddenInput.value = v;
      buttons.forEach(function(b) {
        b.classList.toggle('selected', b.getAttribute('data-value') === String(v));
      });
      container.classList.remove('score-item-error');
      var existingMsg = container.querySelector('.score-item-error-message');
      if (existingMsg) existingMsg.remove();
    }
    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() { selectValue(btn.getAttribute('data-value')); });
    });
    if (hiddenInput.value !== '') selectValue(hiddenInput.value);
  });

  // Call from a form's submit handler BEFORE actually submitting, e.g.:
  //   var check = formHasAllScoreItemsAnswered(formEl);
  //   if (!check.valid) { e.preventDefault(); highlightUnansweredScoreItem(check.firstInvalid); return; }
  // Returns { valid: true } or { valid: false, firstInvalid: <element> }.
  function formHasAllScoreItemsAnswered(formElement) {
    var containers = formElement.querySelectorAll('[data-score-item]');
    for (var i = 0; i < containers.length; i++) {
      var hiddenInput = containers[i].querySelector('input[type=hidden]');
      if (!hiddenInput || hiddenInput.value === '') {
        return { valid: false, firstInvalid: containers[i] };
      }
    }
    return { valid: true, firstInvalid: null };
  }

  // Scrolls to and highlights an unanswered score-item widget with a
  // clear inline message, so a blocked submission is obvious rather than
  // a silent no-op or a generic server-side error after the fact.
  function highlightUnansweredScoreItem(container) {
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    container.classList.add('score-item-error');
    if (!container.querySelector('.score-item-error-message')) {
      var msg = document.createElement('div');
      msg.className = 'score-item-error-message';
      msg.textContent = 'Please choose a value for this before submitting.';
      container.appendChild(msg);
    }
  }
`;

// ---- Stage 3 additions: render a whole domain's widgets from HEALTH_INSTRUMENT ----
// Used by the two server-rendered check-in surfaces (standalone check-in
// page, dashboard's inline modal) so their markup is generated from the
// same config as everything else, instead of a 4th/5th hand-typed copy.
// currentValuesByItemKey is keyed by item.key (e.g. 'stiffness_after_rest'),
// not by full column name.
function buildDomainItemWidgetsHtml(domainKey, currentValuesByItemKey, { baseline = false } = {}) {
  const domain = HEALTH_INSTRUMENT[domainKey];
  return domain.items.map(item => {
    const fieldName = itemColumnName(domainKey, item.key, { baseline });
    const currentValue = currentValuesByItemKey ? currentValuesByItemKey[item.key] : undefined;
    return buildScoreItemWidget(fieldName, item.label, item.anchorLow, item.anchorHigh, currentValue);
  }).join('');
}

// Same idea for a single-item domain (energy, appetite) — one widget, field
// name is the domain's own composite column (no averaging to do).
// hideLabel: true — every call site renders this immediately under its own
// domain heading (e.g. an <h2>/<h3> reading "Energy"), and domain.label is
// that exact same string, so the widget's own <label> would just repeat it.
// The score-buttons group still carries the text via aria-label, so this
// only removes the redundant visible duplicate, not the accessible name.
function buildSingleItemWidgetHtml(domainKey, currentValue, { baseline = false } = {}) {
  const domain = HEALTH_INSTRUMENT[domainKey];
  const fieldName = baseline ? domain.baselineCompositeColumn : domain.compositeColumn;
  return buildScoreItemWidget(fieldName, domain.label, domain.singleItem.anchorLow, domain.singleItem.anchorHigh, currentValue, { hideLabel: true });
}

// ============================================
// MEDICATIONS (category-level tracking)
// Full design rationale: docs/CompanionCommons_Build_Log.md's Sep 2026
// entry for this feature. Locked decisions this code encodes:
//   - Dose is never collected, anywhere.
//   - Medication/supplement NAME is deliberately not a field yet --
//     blocked on real drug-name autocomplete + lawyer review.
//   - Neither medications nor medication_weekly_updates ever stores an
//     owner-identifying column (dog_id + health-relevant fields only),
//     so both stay "separation-compatible" with the future identifiable/
//     de-identifiable architecture split by construction.
// ============================================

// Reuses the exact category vocabulary/labels already established for
// senior_dogs.treatment_category -- one source of truth, not a second
// hand-typed list that could drift from the original.
const MEDICATION_CATEGORIES = Object.keys(TREATMENT_CATEGORY_LABELS);

const MEDICATION_CONDITION_SOURCES = ['owner_observed', 'owner_reported_vet_diagnosis'];
const MEDICATION_CONDITION_SOURCE_LABELS = {
  owner_observed: "I've noticed this myself",
  owner_reported_vet_diagnosis: 'A vet told us this'
};

// The weekly-update "chip" options. 'none' is a real allowed value in
// medication_weekly_updates.change_type's CHECK constraint (matching
// treatment_category's own inclusion of 'none' for vocabulary
// consistency), but the app itself never writes a row with change_type:
// 'none' -- answering "no changes" to the yes/no question simply means
// no row gets created at all, the same "nothing to report = zero rows"
// pattern already used elsewhere in this app.
const MEDICATION_CHANGE_TYPES = ['started_new', 'stopped', 'changed_switched', 'side_effect', 'other'];
const MEDICATION_CHANGE_TYPE_LABELS = {
  started_new: 'Started something new',
  stopped: 'Stopped this medication/supplement',
  changed_switched: 'Changed or switched',
  side_effect: 'Noticed a possible side effect',
  other: 'Something else'
};

// Validates + cleans one raw baseline medication entry. Returns null if
// invalid -- callers reject the WHOLE request on any null rather than
// silently dropping a bad entry, matching isValidInstrumentValue()'s
// established "fail loudly" pattern elsewhere in this file.
function cleanMedicationEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
  if (!MEDICATION_CATEGORIES.includes(category)) return null;

  const conditionTreated = sanitizeString(raw.condition_treated, 100);
  if (!conditionTreated) return null;

  const conditionSource = typeof raw.condition_source === 'string' ? raw.condition_source.trim().toLowerCase() : '';
  if (!MEDICATION_CONDITION_SOURCES.includes(conditionSource)) return null;

  const dateStarted = typeof raw.date_started === 'string' ? raw.date_started.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStarted)) return null;
  const parsedDate = new Date(dateStarted + 'T00:00:00Z');
  // Reject an impossible calendar date (e.g. "2026-02-30" parses to March
  // 2nd instead of throwing, so round-tripping back to the same string is
  // the real check) and reject a future start date -- a medication can't
  // have started in the future.
  if (isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateStarted) return null;
  if (parsedDate > new Date()) return null;

  return { category, condition_treated: conditionTreated, condition_source: conditionSource, date_started: dateStarted };
}

// Validates a whole raw array of baseline medications. undefined/null is
// valid (medications are optional at signup) -> []. Anything else that
// isn't a clean array of valid entries returns null, so the caller can
// reject the whole request rather than silently dropping bad rows.
function cleanMedicationsArray(rawArray) {
  if (rawArray === undefined || rawArray === null) return [];
  if (!Array.isArray(rawArray)) return null;
  const cleaned = [];
  for (const raw of rawArray) {
    const entry = cleanMedicationEntry(raw);
    if (!entry) return null;
    cleaned.push(entry);
  }
  return cleaned;
}

// Single source of truth for "active medications" -- date_stopped IS
// NULL -- checked here and only here, wherever the app needs to know.
async function getActiveMedicationsForDog(dog_id) {
  const { data, error } = await supabase
    .from('medications')
    .select('id, category, condition_treated')
    .eq('dog_id', dog_id)
    .is('date_stopped', null)
    .order('date_started', { ascending: true });
  if (error) {
    console.error(`Error fetching active medications for dog ${dog_id}:`, error.message);
    return [];
  }
  return data || [];
}

// Sets date_stopped (+ updated_at) for one medication. Shared by the
// direct "mark as stopped" endpoint and the weekly-update flow's
// 'stopped' chip, so there's exactly one implementation of what
// "stopping a medication" actually does to the row. .is('date_stopped',
// null) guards against re-stamping an already-stopped row with a new date.
async function stopMedication(medicationId, stopDate = null) {
  const dateStopped = stopDate || new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('medications')
    .update({ date_stopped: dateStopped, updated_at: new Date().toISOString() })
    .eq('id', medicationId)
    .is('date_stopped', null);
  if (error) {
    console.error(`Error stopping medication ${medicationId}:`, error.message);
    return false;
  }
  return true;
}

// Builds the weekly medication-update section for a check-in form.
// Progressive disclosure per the locked UX design:
//   0 active  -> '' (not even the question is rendered)
//   1 active  -> single yes/no, chips shown on "yes", auto-attributed
//   2+ active -> same yes/no, but a "which one?" selector appears first
// Shared by both real check-in surfaces (standalone page, dashboard's
// inline modal) -- one implementation, not a 3rd/4th hand-typed copy.
function buildMedicationUpdateSectionHtml(activeMedications) {
  if (!activeMedications || activeMedications.length === 0) return '';

  const single = activeMedications.length === 1;
  const questionLabel = single
    ? `Any changes to ${escapeHtml(TREATMENT_CATEGORY_LABELS[activeMedications[0].category] || activeMedications[0].category)} this week?`
    : `Any changes to your dog's medications or supplements this week?`;

  const whichOneHtml = single ? '' : `
    <div id="medWhichOne" style="display: none; margin-top: 12px;">
      <label for="medication_id">Which one?</label>
      <select id="medication_id" name="medication_id">
        <option value="">Select one</option>
        ${activeMedications.map(m => `<option value="${m.id}">${escapeHtml(TREATMENT_CATEGORY_LABELS[m.category] || m.category)} (${escapeHtml(m.condition_treated)})</option>`).join('')}
      </select>
    </div>`;

  const chipsHtml = `
    <div id="medChips" style="display: none; margin-top: 12px;">
      <label for="medication_change_type">What changed?</label>
      <select id="medication_change_type" name="medication_change_type">
        <option value="">Select one</option>
        ${MEDICATION_CHANGE_TYPES.map(t => `<option value="${t}">${escapeHtml(MEDICATION_CHANGE_TYPE_LABELS[t])}</option>`).join('')}
      </select>
      <label for="medication_update_note" style="margin-top: 10px;">Anything else? (optional)</label>
      <input type="text" id="medication_update_note" name="medication_update_note" maxlength="200" placeholder="A short note">
    </div>`;

  return `
    <h2 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Medications &amp; Supplements</h2>
    <div id="medUpdateSection" data-single="${single}">
      <label>${questionLabel}</label>
      <div style="display: flex; gap: 16px; margin-top: 6px;">
        <label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 400;"><input type="radio" name="medication_update_answer" value="yes"> Yes</label>
        <label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 400;"><input type="radio" name="medication_update_answer" value="no" checked> No</label>
      </div>
      ${whichOneHtml}
      ${chipsHtml}
    </div>`;
}

// Client-side show/hide wiring + pre-submit validation for the section
// above. Same style as SCORE_ITEM_WIDGET_SCRIPT (plain functions in the
// page's own global scope, not a module) -- if #medUpdateSection isn't on
// the page (0 active medications), every function here is a safe no-op.
const MEDICATION_UPDATE_SCRIPT = `
  (function() {
    var section = document.getElementById('medUpdateSection');
    if (!section) return;
    var isSingle = section.getAttribute('data-single') === 'true';
    var whichOne = document.getElementById('medWhichOne');
    var chips = document.getElementById('medChips');
    var medSelect = document.getElementById('medication_id');

    function updateVisibility() {
      var checked = section.querySelector('input[name="medication_update_answer"]:checked');
      var yes = !!checked && checked.value === 'yes';
      if (whichOne) whichOne.style.display = (yes && !isSingle) ? 'block' : 'none';
      var showChips = yes && (isSingle || (medSelect && medSelect.value));
      if (chips) chips.style.display = showChips ? 'block' : 'none';
    }

    var radios = section.querySelectorAll('input[name="medication_update_answer"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', updateVisibility);
    }
    if (medSelect) medSelect.addEventListener('change', updateVisibility);
  })();

  // Call from a form's submit handler alongside formHasAllScoreItemsAnswered.
  // Returns { valid: true } or { valid: false, message: '...' }.
  function medicationUpdateSectionIsValid() {
    var section = document.getElementById('medUpdateSection');
    if (!section) return { valid: true };
    var checked = section.querySelector('input[name="medication_update_answer"]:checked');
    if (!checked || checked.value !== 'yes') return { valid: true };
    var isSingle = section.getAttribute('data-single') === 'true';
    if (!isSingle) {
      var medSelect = document.getElementById('medication_id');
      if (!medSelect || !medSelect.value) {
        return { valid: false, message: 'Please select which medication or supplement changed.' };
      }
    }
    var changeType = document.getElementById('medication_change_type');
    if (!changeType || !changeType.value) {
      return { valid: false, message: 'Please select what changed.' };
    }
    return { valid: true };
  }
`;

// ============================================
// VALIDATE REQUIRED ENVIRONMENT VARIABLES
// ============================================
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ FATAL: Missing required environment variables:', missingVars);
  console.error('Create .env file in project root with all required variables');
  process.exit(1);
}

console.log('✅ All required environment variables loaded');

const PORT = process.env.PORT || 3000;

// The public web address used inside links sent to users (SMS, email).
// Locally this defaults to your home network IP so testing on your own
// devices still works. On Railway, set BASE_URL=https://companioncommons.com
// as an environment variable and every link will use the real domain
// instead — no code changes needed when you deploy.
const BASE_URL = process.env.BASE_URL || `http://192.168.1.19:${PORT}`;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================
// SITE LOCK ("Coming Soon" gate)
// ============================================
// Set SITE_PASSWORD in your .env (locally) or in your hosting provider's
// environment variables (e.g. Railway) to hide the ENTIRE site — every
// page and every form — behind a simple password wall showing a
// "Coming Soon" splash instead. Leave SITE_PASSWORD unset/blank and the
// site behaves 100% normally with no gate at all. To go public for real,
// just remove the SITE_PASSWORD variable — no code changes needed.
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const SITE_UNLOCK_COOKIE = 'cc_site_access';

function siteUnlockHash(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// ============================================
// OWNER SESSION (STAGE 5 — multi-dog owner project)
// Additive-only convenience cookie, NOT an auth/login system. It never
// gates access to anything — dashboard and Journey Summary links keep
// working with zero session for anyone (a vet, a family member), exactly
// as they always have. All this cookie ever does is let /dashboard/:dog_id
// show a bonus dog switcher when the browser holding it already proved
// phone ownership once via the real magic-link /verify flow. See
// Multi_Dog_Signup_Build.md, Stage 5, for the full design and the
// cross-owner edge case this is deliberately guarded against.
// ============================================
const OWNER_SESSION_COOKIE = 'cc_owner_session';
const OWNER_SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days, sliding

function setOwnerSessionCookie(res, ownerId) {
  res.cookie(OWNER_SESSION_COOKIE, ownerId, {
    httpOnly: true,
    maxAge: OWNER_SESSION_MAX_AGE,
    sameSite: 'lax'
  });
}

// Renders a horizontal tab strip linking to each of the owner's dogs,
// highlighting whichever one is currently being viewed. Only ever called
// when a session cookie's owner_id has already been confirmed to match the
// dog on screen and the owner has more than one dog — see the call site in
// /dashboard/:dog_id.
function buildDogSwitcherHtml(ownersDogs, currentDogId) {
  const tabs = ownersDogs.map(d => {
    const isActive = d.id === currentDogId;
    const photoHtml = d.photo_url
      ? `<img src="${d.photo_url}" alt="" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover; margin-right: 6px; vertical-align: middle;" />`
      : '';
    return `<a href="/dashboard/${d.id}" style="display: inline-flex; align-items: center; padding: 8px 14px; margin: 0 6px 6px 0; border-radius: 20px; text-decoration: none; font-size: 14px; font-weight: 600; ${isActive ? 'background: #d96f56; color: white;' : 'background: #f0ece3; color: #555;'}">${photoHtml}${escapeHtml(d.dog_name)}</a>`;
  }).join('');

  return `
    <div style="margin: 16px 0;">
      <div>${tabs}</div>
      <a href="#" onclick="fetch('/api/clear-owner-session', {method:'POST'}).then(() => window.location.reload()); return false;" style="font-size: 12px; color: #999; text-decoration: underline;">Not your device? Clear saved account</a>
    </div>
  `;
}

const COMING_SOON_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Companion Commons — Coming Soon</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#2E2A26; color:#fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .box { max-width: 420px; padding: 40px; text-align: center; }
  h1 { font-size: 28px; margin-bottom: 12px; }
  p { opacity: .8; line-height: 1.5; margin-bottom: 28px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 8px; border: none;
         font-size: 16px; margin-bottom: 14px; }
  button { width: 100%; padding: 12px 14px; border-radius: 8px; border: none; background:#d96f56; color:#fff;
         font-size: 16px; font-weight: 600; cursor: pointer; }
  .error { color: #ff9b9b; font-size: 14px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
  <div class="box">
    <h1>Companion Commons</h1>
    <p>We're still building. If you've got the password, come on in.</p>
    <form id="unlockForm">
      <input type="password" id="pw" placeholder="Password" autofocus required />
      <button type="submit">Enter</button>
      <div class="error" id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('unlockForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      try {
        const res = await fetch('/api/site-unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          errEl.textContent = 'Wrong password, try again.';
        }
      } catch (err) {
        errEl.textContent = 'Something went wrong, try again.';
      }
    });
  </script>
</body>
</html>`;

app.post('/api/site-unlock', (req, res) => {
  if (!SITE_PASSWORD) return res.json({ success: true }); // lock disabled
  const { password } = req.body || {};
  if (password && password === SITE_PASSWORD) {
    res.cookie(SITE_UNLOCK_COOKIE, siteUnlockHash(SITE_PASSWORD), {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax'
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

// STAGE 5 (multi-dog owner project) — lets someone clear a saved owner
// session from a shared/public device. Clearing it only ever removes the
// bonus dog-switcher on future visits; it was never required to see any
// dog's data in the first place, so there's nothing else for this to do.
app.post('/api/clear-owner-session', (req, res) => {
  res.clearCookie(OWNER_SESSION_COOKIE);
  res.json({ success: true });
});

app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next(); // no password set = gate fully disabled

  // Always allow through: the unlock endpoint itself, hosting-provider
  // health checks, Twilio's own status-callback webhook (Twilio's servers
  // obviously can't type in a password), and the legal pages + their
  // styling/script assets — Twilio's A2P 10DLC campaign review requires
  // Privacy Policy / Terms URLs to be live and publicly reachable with NO
  // password, even while the rest of the site stays locked down.
  const alwaysAllowed =
    req.path === '/api/site-unlock' ||
    req.path === '/health' ||
    req.path.startsWith('/api/sms/') ||
    req.path === '/privacy.html' ||
    req.path === '/terms.html' ||
    req.path.startsWith('/assets/');

  if (alwaysAllowed) return next();

  const cookies = parseCookies(req);
  if (cookies[SITE_UNLOCK_COOKIE] === siteUnlockHash(SITE_PASSWORD)) {
    return next(); // already unlocked on this browser
  }

  if (req.method === 'GET') {
    return res.status(200).send(COMING_SOON_HTML);
  }
  return res.status(401).json({ error: 'Site is locked' });
});

app.use(express.static('Public'));

// ============================================
// ADMIN PANEL AUTH
// ============================================
// Same server-side password + hashed-cookie pattern as the SITE_PASSWORD
// gate above, but a separate, independent lock scoped to just /admin and
// the /api/page/* content API it uses. Set ADMIN_PASSWORD in your .env
// (locally) or your hosting provider's environment variables (e.g.
// Railway) — never hardcode it in this file.
//
// Unlike SITE_PASSWORD, leaving ADMIN_PASSWORD unset does NOT open the
// gate — it locks the admin panel out entirely (returns 503). Admin is a
// sensitive internal tool, not something that should ever be reachable by
// default the way the public "Coming Soon" splash is designed to be.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_UNLOCK_COOKIE = 'cc_admin_access';

function isAdminUnlocked(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookies = parseCookies(req);
  return cookies[ADMIN_UNLOCK_COOKIE] === siteUnlockHash(ADMIN_PASSWORD);
}

app.post('/api/admin-unlock', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, error: 'Admin panel is not configured' });
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    res.cookie(ADMIN_UNLOCK_COOKIE, siteUnlockHash(ADMIN_PASSWORD), {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax'
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

app.post('/api/admin-logout', (req, res) => {
  res.clearCookie(ADMIN_UNLOCK_COOKIE);
  res.json({ success: true });
});

// Guards the page-content API the admin panel reads/writes through — this
// is the endpoint that actually mutates site content, so it needs the same
// server-side check as the /admin page itself (previously this had NO
// authentication at all, regardless of what /admin showed in the browser).
app.use('/api/page', (req, res, next) => {
  if (!isAdminUnlocked(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ============================================
// SUPABASE SETUP
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (SUPABASE_SERVICE_ROLE_KEY) {
  console.log('✅ Service role key loaded');
} else {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY not in .env');
}

// Uses the service role key, not the anon key — this client is used for
// nearly every read/write in the app, and there is no browser-side/anon
// access path anywhere in this codebase (confirmed: zero client-side
// Supabase usage in Public/*.html). Service role bypasses RLS by design,
// which is required now that RLS is enabled on every table — see
// migration_enable_rls_all_tables.sql. SUPABASE_ANON_KEY is kept defined
// above since it's still a required env var, but is no longer used by
// this client.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================
// SUPABASE ADMIN CLIENT (for bucket creation)
// ============================================
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Ensure bucket exists on startup
(async () => {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.storage.createBucket('Dog_Photos', { public: true });
    console.log('✅ Dog_Photos bucket ready');
  } catch (e) {
    if (e.message?.includes('already exists')) {
      console.log('✅ Dog_Photos bucket exists');
    } else {
      console.error('⚠️ Bucket error:', e.message);
    }
  }
})();

// ============================================
// TWILIO SETUP
// ============================================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ============================================
// SENDGRID SETUP (Email)
// ============================================
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'companioncommons@gmail.com';
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('✅ SendGrid initialized');
} else {
  console.warn('⚠️ SENDGRID_API_KEY not set. Email features disabled.');
}

// ============================================
// GOOGLE SHEETS SETUP
// ============================================
// GOOGLE SHEETS INTEGRATION
// Rebuilt Aug 19 — the old version looked for a credentials FILE on disk,
// which never worked once deployed (service account keys correctly never
// get committed to GitHub, so the file was never actually present on
// Railway — this is why every startup log showed "key file not found").
// Now reads credentials from the GOOGLE_SHEETS_CREDENTIALS environment
// variable instead, set directly in Railway.
// ============================================
const SHEET_ID = '1Qxm9pbI9PuE-dxCKJ5UrrspJGYcZXfb-fLwB69UyBsY';
let sheetsClient = null;

function loadGoogleSheetsAuth() {
  try {
    const credsBase64 = process.env.GOOGLE_SHEETS_CREDENTIALS_BASE64;

    if (!credsBase64) {
      console.warn('⚠️ GOOGLE_SHEETS_CREDENTIALS_BASE64 env var not set. Skipping Google Sheets integration.');
      return null;
    }

    // Base64-decode first — this sidesteps a common .env gotcha where literal
    // \n escape sequences inside a raw JSON value can get misinterpreted as
    // real line breaks by some .env parsers, breaking JSON.parse.
    const credsJson = Buffer.from(credsBase64, 'base64').toString('utf8');
    const keyData = JSON.parse(credsJson);

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log(`✅ Google Sheets authenticated (${keyData.client_email})`);
    return true;
  } catch (error) {
    console.warn('⚠️ Failed to load Google Sheets:', error.message);
    return null;
  }
}

// Initialize Google Sheets on startup
loadGoogleSheetsAuth();

// ============================================
// INPUT SANITIZATION FUNCTIONS (SECURITY)
// ============================================

// Sanitize strings: trim whitespace, remove null bytes, basic XSS prevention
const sanitizeString = (str, maxLength = 500) => {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/\0/g, '') // Remove null bytes
    .substring(0, maxLength);
};

// Sanitize email: trim, lowercase, remove dangerous characters
const sanitizeEmail = (email) => {
  if (typeof email !== 'string') return '';
  return email
    .trim()
    .toLowerCase()
    .replace(/[<>\"']/g, ''); // Remove quote/bracket characters
};

// Sanitize name fields: allow letters, spaces, hyphens, apostrophes only
const sanitizeName = (name, maxLength = 100) => {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[^a-zA-Z\s\-\']/g, '') // Remove special characters except -, '
    .substring(0, maxLength);
};

// Sanitize + validate phone: must resolve to a real, valid US number.
//
// Replaced Sep 1 2026's digit-count guessing (10 digits -> assume US,
// 11-15 digits -> accept as-is) -- that let a correctly country-coded
// non-US number (e.g. a UK mobile as +447911123456) pass through
// completely unvalidated, closed as its own gap that session. Real
// parsing via libphonenumber-js closes the remaining, more important
// gap: Twilio's account-level Geo Permissions (restricted by John) can
// only gate by country, and the US and Canada share the +1 country code
// -- Twilio's own setting structurally cannot tell them apart. This
// app-layer check can, using real North American Numbering Plan area-
// code data (e.g. Toronto's 416 resolves to CA, not US), confirmed
// empirically before this was written.
//
// The 'US' default-country hint means a bare national number typed
// without a country code (e.g. "4155552671" or "(415) 555-2671") is
// still correctly interpreted as a US number, same as before -- the
// hint only applies when the input has no explicit country code of its
// own (a leading + or 00 always wins over the hint).
const sanitizePhone = (phone) => {
  if (typeof phone !== 'string') return '';
  const parsed = parsePhoneNumberFromString(phone, 'US');
  if (!parsed || !parsed.isValid() || parsed.country !== 'US') return '';
  return parsed.number; // E.164, e.g. "+14155552671" -- same return shape as before
};

// Sanitize select fields (gender, trend, etc): lowercase, limit to allowed values
const sanitizeSelect = (value, allowedValues) => {
  if (typeof value !== 'string') return allowedValues[0] || '';
  const normalized = value.toLowerCase().trim();
  return allowedValues.includes(normalized) ? normalized : allowedValues[0] || '';
};

// Sanitize array of strings (treatments, observations)
const sanitizeArray = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => typeof item === 'string' ? sanitizeString(item, 100) : '')
    .filter(item => item.length > 0);
};

// ============================================
// RATE LIMITING (SECURITY - PREVENTS ABUSE)
// ============================================

// In-memory stores for rate limiting (production should use Redis)
const requestCounts = new Map(); // Track requests per IP
const smsCounts = new Map(); // Track sends per contact (phone or email) per day
// Track lookups per IP specifically for /api/resend-dashboard-link -- separate
// from requestCounts (the generic 10-req/10-sec-per-IP limiter applied to all
// POST routes) since that's far too loose for a sensitive "does this phone
// number/email exist in our system" lookup. Applied directly inside that one
// route handler, not registered as app-wide middleware, so it only ever
// covers POST /api/resend-dashboard-link -- never GET page loads of
// find-my-dashboard.html itself.
const resendLookupIpCounts = new Map();

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  for (const [key, data] of requestCounts.entries()) {
    if (data.timestamp < oneHourAgo) {
      requestCounts.delete(key);
    }
  }

  for (const [key, data] of resendLookupIpCounts.entries()) {
    if (data.timestamp < oneHourAgo) {
      resendLookupIpCounts.delete(key);
    }
  }

  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  for (const [key, data] of smsCounts.entries()) {
    if (data.timestamp < oneDayAgo) {
      smsCounts.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Middleware: Rate limit API requests (max 10 requests per 10 seconds per IP)
const apiRateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowSize = 10 * 1000; // 10 second window
  const maxRequests = 10;

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, timestamp: now });
    return next();
  }

  const data = requestCounts.get(ip);

  // Reset if window expired
  if (now - data.timestamp > windowSize) {
    requestCounts.set(ip, { count: 1, timestamp: now });
    return next();
  }

  // Increment count
  data.count += 1;

  // Check limit
  if (data.count > maxRequests) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((windowSize - (now - data.timestamp)) / 1000)
    });
  }

  next();
};

// Rate limit sends per contact (max 10 per phone number or email per day).
// Named generically (not smsRateLimit) since it's keyed by whatever
// identifier a caller passes -- phone or email both use this same function
// for /api/resend-dashboard-link. Still just one real call site.
const perContactRateLimit = (identifier) => {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  if (!smsCounts.has(identifier)) {
    smsCounts.set(identifier, { count: 1, timestamp: now });
    return { allowed: true };
  }

  const data = smsCounts.get(identifier);

  // Reset if day expired
  if (now - data.timestamp > 24 * 60 * 60 * 1000) {
    smsCounts.set(identifier, { count: 1, timestamp: now });
    return { allowed: true };
  }

  // Check limit (max 10 per day)
  if (data.count >= 10) {
    return {
      allowed: false,
      message: 'Send limit reached. Max 10 per day.',
      retryAfter: Math.ceil((24 * 60 * 60 * 1000 - (now - data.timestamp)) / 1000)
    };
  }

  // Increment count
  data.count += 1;
  return { allowed: true };
};

// Anti-enumeration limiter for /api/resend-dashboard-link specifically: max 5
// lookups per IP per 15 minutes. Deliberately much stricter than the generic
// apiRateLimit (10 req/10sec/IP, ~3,600/hour) -- that's far too loose for a
// "does this phone number/email exist in our system" lookup, where legitimate
// use is rare (lost your link once in a while) but breadth-probing many
// different candidates from one IP is exactly the pattern worth slowing down.
// Numbers are a provisional starting guess, not validated against real usage
// -- same as this project's other initial threshold choices -- revisit if
// real legitimate users ever hit this.
const resendLookupIpRateLimit = (ip) => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 5;

  if (!resendLookupIpCounts.has(ip)) {
    resendLookupIpCounts.set(ip, { count: 1, timestamp: now });
    return { allowed: true };
  }

  const data = resendLookupIpCounts.get(ip);

  if (now - data.timestamp > windowMs) {
    resendLookupIpCounts.set(ip, { count: 1, timestamp: now });
    return { allowed: true };
  }

  if (data.count >= maxRequests) {
    return { allowed: false };
  }

  data.count += 1;
  return { allowed: true };
};

// Same pattern as resendLookupIpRateLimit above, for the public Contact Us
// form: max 5 submissions per IP per 15 minutes. A contact form is an open
// endpoint (no owner lookup, no enumeration risk) but is still a real spam
// target, so it gets its own IP limiter rather than relying solely on the
// generic apiRateLimit (10 req/10sec/IP -- far too loose to slow down a
// scripted spam run on its own).
const contactFormIpCounts = new Map();
const contactFormIpRateLimit = (ip) => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 5;

  if (!contactFormIpCounts.has(ip)) {
    contactFormIpCounts.set(ip, { count: 1, timestamp: now });
    return { allowed: true };
  }

  const data = contactFormIpCounts.get(ip);

  if (now - data.timestamp > windowMs) {
    contactFormIpCounts.set(ip, { count: 1, timestamp: now });
    return { allowed: true };
  }

  if (data.count >= maxRequests) {
    return { allowed: false };
  }

  data.count += 1;
  return { allowed: true };
};

// Apply API rate limiting to all POST endpoints
app.post('*', apiRateLimit);

// ============================================
// ADMIN PANEL - EMBEDDED (UNCHANGED)
// ============================================
app.get('/admin', (req, res) => {
    if (!isAdminUnlocked(req)) {
        return res.send(`<!DOCTYPE html>
<html>
<head>
    <title>CompanionCommons Admin — Login</title>
    <style>
        body { font-family: Arial; background: #f0f0f0; padding: 20px; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
        .container { max-width: 340px; width: 100%; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin: 0 0 20px 0; font-size: 20px; }
        input { width: 100%; padding: 10px; margin-bottom: 14px; border: 1px solid #ddd; font-family: Arial; font-size: 14px; box-sizing: border-box; }
        button { width: 100%; background: #4CAF50; color: white; padding: 12px 24px; border: none; cursor: pointer; font-size: 16px; font-weight: bold; border-radius: 4px; }
        button:hover { background: #45a049; }
        .error { color: #c33; font-size: 14px; margin-top: 10px; min-height: 18px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>CompanionCommons Admin</h1>
        <form id="loginForm">
            <input type="password" id="password" placeholder="Admin password" autofocus required>
            <button type="submit">Login</button>
            <div class="error" id="err"></div>
        </form>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            const errEl = document.getElementById('err');
            errEl.textContent = '';
            try {
                const res = await fetch('/api/admin-unlock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (res.ok) {
                    window.location.reload();
                } else {
                    errEl.textContent = 'Incorrect password.';
                }
            } catch (error) {
                errEl.textContent = 'Something went wrong, try again.';
            }
        });
    </script>
</body>
</html>`);
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>CompanionCommons Admin</title>
    <style>
        body { font-family: Arial; background: #f0f0f0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-bottom: 30px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; font-weight: bold; margin-bottom: 8px; color: #333; }
        input, textarea, select { width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #ddd; font-family: Arial; font-size: 14px; }
        textarea { min-height: 100px; }
        button { background: #4CAF50; color: white; padding: 12px 24px; border: none; cursor: pointer; font-size: 16px; font-weight: bold; border-radius: 4px; }
        button:hover { background: #45a049; }
        .message { padding: 15px; margin-bottom: 20px; border-radius: 4px; display: none; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    </style>
</head>
<body>
    <div class="container">
        <h1><i data-lucide="target"></i> CompanionCommons Admin</h1>
        <button onclick="logout()" style="float:right;">Logout</button>
        <div style="clear:both;"></div>

        <div id="message" class="message"></div>

        <div class="form-group">
            <label>Select Page:</label>
            <select id="page" onchange="loadPage()">
                <option value="home">Home</option>
                <option value="about">About</option>
                <option value="independent">Independent</option>
                <option value="privacy">Privacy</option>
                <option value="faq">FAQ</option>
                <option value="founding">Founding</option>
            </select>
        </div>

        <div class="form-group">
            <label>Headline:</label>
            <input type="text" id="headline" placeholder="Page headline">
        </div>

        <div class="form-group">
            <label>Subheading:</label>
            <input type="text" id="subheading" placeholder="Page subheading">
        </div>

        <div class="form-group">
            <label>CTA Button Text:</label>
            <input type="text" id="cta" placeholder="Button text">
        </div>

        <div class="form-group">
            <label>Body Content:</label>
            <textarea id="body" placeholder="Main content"></textarea>
        </div>

        <div class="form-group">
            <label>Secondary Text:</label>
            <textarea id="secondary" placeholder="Additional content"></textarea>
        </div>

        <button onclick="savePage()"><i data-lucide="save"></i> Save Changes</button>
    </div>

    <script>
        function logout() {
            fetch('/api/admin-logout', { method: 'POST' }).then(() => window.location.reload());
        }

        async function loadPage() {
            const page = document.getElementById('page').value;
            try {
                const res = await fetch('/api/page/' + page);
                if (res.status === 401) return window.location.reload();
                const data = await res.json();
                document.getElementById('headline').value = data.hero_headline || '';
                document.getElementById('subheading').value = data.hero_subheading || '';
                document.getElementById('cta').value = data.hero_cta || '';
                document.getElementById('body').value = data.body_content || '';
                document.getElementById('secondary').value = data.secondary_text || '';
            } catch (error) {
                console.error('Error loading page:', error);
            }
        }

        async function savePage() {
            const page = document.getElementById('page').value;
            try {
                const res = await fetch('/api/page/' + page, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        hero_headline: document.getElementById('headline').value,
                        hero_subheading: document.getElementById('subheading').value,
                        hero_cta: document.getElementById('cta').value,
                        body_content: document.getElementById('body').value,
                        secondary_text: document.getElementById('secondary').value
                    })
                });
                if (res.status === 401) return window.location.reload();
                if (res.ok) {
                    showMessage('Saved successfully!', 'success');
                } else {
                    showMessage('Error saving page', 'error');
                }
            } catch (error) {
                console.error('Error saving:', error);
                showMessage('Error saving page', 'error');
            }
        }

        function showMessage(text, type) {
            const msg = document.getElementById('message');
            msg.textContent = text;
            msg.className = 'message ' + type;
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 5000);
        }

        loadPage();
    </script>
    <script src="https://unpkg.com/lucide@1.33.0"></script>
    <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
</body>
</html>`);
});

// ============================================
// PAGE CONTENT API (admin-only — guarded by the /api/page auth middleware above)
// ============================================
app.get('/api/page/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { data, error } = await supabase
            .from('page_content')
            .select('*')
            .eq('page_slug', slug)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        res.json(data || { page_slug: slug });
    } catch (error) {
        console.error('Error fetching page:', error);
        res.status(500).json({ error: 'Error fetching page' });
    }
});

app.post('/api/page/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const content = req.body;

        content.updated_at = new Date().toISOString();
        content.page_slug = slug;

        const { data: existing } = await supabase
            .from('page_content')
            .select('id')
            .eq('page_slug', slug)
            .single();

        let result;
        if (existing) {
            result = await supabase
                .from('page_content')
                .update(content)
                .eq('page_slug', slug);
        } else {
            result = await supabase
                .from('page_content')
                .insert([content]);
        }

        if (result.error) throw result.error;

        res.json({ success: true, message: 'Page updated' });
    } catch (error) {
        console.error('Error saving page:', error);
        res.status(500).json({ error: 'Error saving page' });
    }
});

// ============================================
// GOOGLE SHEETS DATA EXPORT FUNCTION
// ============================================
// Ensures both tabs (Signups, CheckIns) exist in the spreadsheet.
// Runs once at startup. If the sheet was just created blank (only has the
// default "Sheet1"), this creates both tabs we actually need.
// ============================================
async function ensureGoogleSheetTabsExist() {
  if (!sheetsClient) return;

  try {
    const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTitles = spreadsheet.data.sheets.map(s => s.properties.title);

    const neededTabs = ['Signups', 'CheckIns', 'Notes'];
    const tabsToCreate = neededTabs.filter(t => !existingTitles.includes(t));

    if (tabsToCreate.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: tabsToCreate.map(title => ({ addSheet: { properties: { title } } }))
        }
      });
      console.log(`✅ Created Google Sheets tabs: ${tabsToCreate.join(', ')}`);

      // Add header rows to any newly-created tabs
      //
      // STEP P10: score columns labeled "(0-10)" as of Aug 23 — the
      // underlying scale changed from the old 1-8 "higher=better" slider to
      // a 0-10 "higher=more concerning" composite (see
      // docs/CompanionCommons_Health_Instrument_Design.md). This code only
      // runs when a tab is created for the first time; Signups/CheckIns/
      // Notes already exist, so this label change does NOT retroactively
      // update the live sheet's actual header row — that needs a manual
      // edit, same as the weight-column addition on Aug 20. Values
      // exported are composites only, matching the Stage 1 decision to
      // keep item-level detail in Supabase rather than widen the sheet.
      if (tabsToCreate.includes('Signups')) {
        await appendRowToSheet('Signups', [
          'Timestamp', 'Dog ID', 'Email', 'Dog Name', 'Breed', 'Age', 'Gender', 'Baseline Weight',
          'Baseline Mobility (0-10)', 'Baseline Energy (0-10)', 'Baseline Appetite (0-10)', 'Baseline Cognitive (0-10)',
          // Added Aug 31 2026 — these were collected at signup since the
          // Aug 16/20 form expansions but never reached Sheets. Appended
          // at the end (not inserted mid-row) so existing column
          // positions don't shift. Free-text baseline_notes is
          // deliberately still excluded — structured scores only.
          'Phone', 'Zip Code', 'Spayed/Neutered', 'Diet Type', 'Pet Insurance', 'Treatment Category',
          'SMS Consent', 'Consent Given At'
        ]);
      }
      if (tabsToCreate.includes('CheckIns')) {
        await appendRowToSheet('CheckIns', [
          'Timestamp', 'Dog ID', 'Dog Name', 'Week Number', 'Mobility (0-10)', 'Energy (0-10)', 'Appetite (0-10)', 'Cognitive (0-10)', 'Weight', 'Notes'
        ]);
      }
      if (tabsToCreate.includes('Notes')) {
        await appendRowToSheet('Notes', [
          'Timestamp', 'Dog ID', 'Dog Name', 'Note'
        ]);
      }
    }
  } catch (error) {
    console.warn('⚠️ Failed to verify/create Google Sheets tabs:', error.message);
  }
}

// ============================================
// Appends one row to the given tab. Uses the standard "append" API, which
// automatically finds the next empty row — simpler and one fewer network
// call than the old approach (which fetched sheet metadata every time just
// to append cells manually).
// ============================================
async function appendRowToSheet(tabName, rowValues) {
  if (!sheetsClient) {
    console.log('ℹ️ Google Sheets not connected, skipping export');
    return;
  }

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [rowValues] }
    });
  } catch (error) {
    console.error(`⚠️ Failed to append to Google Sheets tab "${tabName}":`, error.message);
  }
}

// Builds the 8 trailing Signups-tab columns (Phone, Zip Code,
// Spayed/Neutered, Diet Type, Pet Insurance, Treatment Category,
// SMS Consent, Consent Given At) shared by both real signup call sites
// (/verify and /api/add-dog) — one implementation instead of two, so the
// two write sites can't independently drift the way headers and writes
// have drifted apart before in this project.
//
// Zip code AND phone are both wrapped with a leading apostrophe:
// appendRowToSheet uses valueInputOption 'USER_ENTERED', which
// auto-parses a numeric-looking string the same way Google Sheets parses
// manual typing. A zip like "02134" would silently become 2134, losing
// the leading zero; a phone like "+15005550006" gets its leading "+"
// stripped and becomes a bare number (confirmed empirically via a real
// signup + Sheets read-back, not assumed — this is exactly the kind of
// silent mangling that's easy to miss without checking). The apostrophe
// prefix is the standard Sheets convention for forcing literal text, same
// as a person manually typing '02134 or '+15005550006 into a cell.
function buildSignupSheetsExtraColumns({ phone, zipCode, spayedNeutered, dietType, petInsurance, treatmentCategories, smsConsent, consentGivenAt }) {
  return [
    phone ? `'${phone}` : '',
    zipCode ? `'${zipCode}` : '',
    spayedNeutered || '',
    dietType || '',
    petInsurance || '',
    (treatmentCategories || []).filter(t => t && t !== 'none').join(', '),
    smsConsent ? 'yes' : 'no',
    consentGivenAt || ''
  ];
}

// Make sure both tabs exist before anything tries to write to them
ensureGoogleSheetTabsExist();


// ============================================
// SMS: QUEUE MANAGEMENT
// NEW ENDPOINTS
// ============================================
app.get('/api/sms/pending', async (req, res) => {
    try {
        const now = new Date().toISOString();

        const { data: pending, error } = await supabase
            .from('sms_queue')
            .select('*')
            .eq('status', 'pending')
            .lte('scheduled_for', now)
            .limit(100);

        if (error) throw error;

        res.json({
            count: pending.length,
            messages: pending
        });
    } catch (error) {
        console.error('Error fetching pending SMS:', error);
        res.status(500).json({ error: 'Error fetching pending SMS' });
    }
});

app.post('/api/sms/send', async (req, res) => {
    try {
        const { message_id, phone, message_body } = req.body;

        if (!phone || !message_body) {
            return res.status(400).json({ error: 'Missing phone or message_body' });
        }

        const sentMessage = await twilioClient.messages.create({
            body: message_body,
            from: TWILIO_PHONE_NUMBER,
            to: phone
        });

        await supabase
            .from('sms_queue')
            .update({
                status: 'sent',
                twilio_sid: sentMessage.sid,
                sent_at: new Date().toISOString()
            })
            .eq('id', message_id);

        console.log(`✅ SMS sent to ${phone} (SID: ${sentMessage.sid})`);

        res.json({
            success: true,
            message: 'SMS sent successfully',
            twilio_sid: sentMessage.sid
        });

    } catch (error) {
        console.error('Error sending SMS:', error);
        res.status(500).json({ error: 'Error sending SMS', details: error.message });
    }
});

app.post('/api/sms/mark-sent', async (req, res) => {
    try {
        const { message_id, twilio_sid } = req.body;

        const { error } = await supabase
            .from('sms_queue')
            .update({
                status: 'sent',
                twilio_sid: twilio_sid,
                sent_at: new Date().toISOString()
            })
            .eq('id', message_id);

        if (error) throw error;

        res.json({ success: true, message: 'SMS marked as sent' });
    } catch (error) {
        console.error('Error marking SMS as sent:', error);
        res.status(500).json({ error: 'Error updating SMS status' });
    }
});

app.post('/api/sms/mark-failed', async (req, res) => {
    try {
        const { message_id, status, error_message } = req.body;

        const { error: updateError } = await supabase
            .from('sms_queue')
            .update({
                status: status || 'failed',
                error_message: error_message,
                updated_at: new Date().toISOString()
            })
            .eq('id', message_id);

        if (updateError) throw updateError;

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking SMS as failed:', error);
        res.status(500).json({ error: 'Error updating SMS status' });
    }
});

app.post('/api/sms/webhook', async (req, res) => {
    try {
        const { MessageSid, MessageStatus, To } = req.body;

        if (!MessageSid) {
            return res.status(400).json({ error: 'Missing MessageSid' });
        }

        const statusMap = {
            'delivered': 'sent',
            'failed': 'failed',
            'undelivered': 'bounced'
        };

        const mappedStatus = statusMap[MessageStatus] || MessageStatus;

        const { error } = await supabase
            .from('sms_queue')
            .update({
                status: mappedStatus,
                updated_at: new Date().toISOString()
            })
            .eq('twilio_sid', MessageSid);

        if (error) {
            console.error('Error updating SMS status from webhook:', error);
        } else {
            console.log(`✅ SMS status updated: ${MessageSid} → ${mappedStatus}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error processing Twilio webhook:', error);
        res.status(500).json({ error: 'Error processing webhook' });
    }
});

// ============================================
// SENIOR DOGS MOBILITY: CHECK-IN FORM PAGE
// NEW ENDPOINT - STEP 4
// ============================================
app.get('/check-in/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;

    // Get dog details from database
    const { data: dog, error } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (error || !dog) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dog Not Found</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }
            .card { background: white; border-radius: 12px; padding: 20px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>❌ Dog Not Found</h2>
            <p>We couldn't find this dog's profile. Please check your link and try again.</p>
          </div>
        </body>
        </html>
      `);
    }

    // STEP: Block check-in access during the 7-day baseline period, not just
    // hide the button. Matches the same rule used on the dashboard — this
    // closes the side door where someone could reach this page directly
    // (an old link, a bookmark, etc.) before their first update is due.
    const daysSinceSignupForCheckin = (new Date() - new Date(dog.created_at)) / (24 * 60 * 60 * 1000);
    if (Math.floor(daysSinceSignupForCheckin / 7) === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Not ready yet</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .cta { display: inline-block; margin-top: 20px; background: #A89968; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="card">
            <p style="font-size: 40px; margin: 0 0 10px 0;"><i data-lucide="clipboard-list"></i></p>
            <h2 style="margin: 0 0 10px 0;">Not quite ready yet</h2>
            <p style="color: #666;">${dog.dog_name}'s first weekly update becomes available 7 days after signing up. You'll get a text when it's time.</p>
            <a href="/dashboard/${dog_id}" class="cta">View Dashboard</a>
          </div>
          <script src="https://unpkg.com/lucide@1.33.0"></script>
          <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
        </body>
        </html>
      `);
    }

    // Get check-in history for comparison. No .limit(1) — weight isn't
    // recorded every week (only every 4th, same as cognitive), so the full
    // history is fetched to find the latest check-in that actually has one.
    // STEP P10: also selects the 8 item columns, ordered newest-first so
    // [0] is always "most recent check-in of any kind."
    const { data: latestCheckins } = await supabase
      .from('mobility_checkins')
      .select('mobility_getting_up, mobility_stairs, mobility_stiffness_after_rest, mobility_walk_distance, energy_score, appetite_score, cognitive_orientation, cognitive_memory, cognitive_interest, cognitive_sleep_wake, weight_lbs, week_number')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });

    // Mobility is asked every week, so the most recent row (if any) always
    // has real item values. Cognitive is only asked every 4th week, so the
    // most recent row often has null cognitive_* — find the most recent row
    // that actually HAS cognitive values instead, same pattern already used
    // for weight below.
    const latestRow = latestCheckins?.[0];
    const latestCognitiveRow = latestCheckins?.find(c => c.cognitive_orientation != null);

    const mobilityPrefill = {
      getting_up: latestRow?.mobility_getting_up ?? dog.baseline_mobility_getting_up ?? null,
      stairs: latestRow?.mobility_stairs ?? dog.baseline_mobility_stairs ?? null,
      stiffness_after_rest: latestRow?.mobility_stiffness_after_rest ?? dog.baseline_mobility_stiffness_after_rest ?? null,
      walk_distance: latestRow?.mobility_walk_distance ?? dog.baseline_mobility_walk_distance ?? null
    };
    const cognitivePrefill = {
      orientation: latestCognitiveRow?.cognitive_orientation ?? dog.baseline_cognitive_orientation ?? null,
      memory: latestCognitiveRow?.cognitive_memory ?? dog.baseline_cognitive_memory ?? null,
      interest: latestCognitiveRow?.cognitive_interest ?? dog.baseline_cognitive_interest ?? null,
      sleep_wake: latestCognitiveRow?.cognitive_sleep_wake ?? dog.baseline_cognitive_sleep_wake ?? null
    };
    const latestEnergy = latestRow?.energy_score ?? dog.baseline_energy_score ?? null;
    const latestAppetite = latestRow?.appetite_score ?? dog.baseline_appetite_score ?? null;
    const latestWeight = latestCheckins?.find(c => c.weight_lbs != null)?.weight_lbs ?? dog.weight_lbs ?? null;
    const activeMedications = await getActiveMedicationsForDog(dog_id);

    // Calculate the actual current week based on when the dog was enrolled
    // (matches the same calculation used at submission time in /api/checkin-senior)
    const created = new Date(dog.created_at);
    const now = new Date();
    const weekNumber = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    // Bug found via real-device testing (Aug 24): this page previously had
    // no awareness of whether the current computed week already had a real
    // submission — it just rendered the form pre-filled with the latest
    // values, giving zero indication a check-in already existed. Someone
    // revisiting the same link within the same week (e.g. tapping an old
    // reminder text a second time) would see what looks like a normal,
    // inviting blank-ish form and could submit again, creating a second
    // mobility_checkins row for the same dog+week. latestCheckins is
    // already fetched above with week_number selected, so this is a free
    // check against data already in hand, not a new query.
    const alreadySubmittedThisWeek = latestCheckins?.some(c => c.week_number === weekNumber);
    if (alreadySubmittedThisWeek) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Already checked in</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .cta { display: inline-block; margin-top: 20px; background: #A89968; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="card">
            <p style="font-size: 40px; margin: 0 0 10px 0;"><i data-lucide="check-circle"></i></p>
            <h2 style="margin: 0 0 10px 0;">Already checked in this week ✓</h2>
            <p style="color: #666;">${dog.dog_name}'s update for week ${weekNumber} is already recorded. Come back next week for the next one.</p>
            <a href="/dashboard/${dog_id}" class="cta">View Dashboard</a>
          </div>
          <script src="https://unpkg.com/lucide@1.33.0"></script>
          <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
        </body>
        </html>
      `);
    }

    // Cognitive/behavior is only asked every 4th week (4, 8, 12...)
    const showCognitive = weekNumber % 4 === 0;

    // Send HTML form
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(dog.dog_name)}'s Check-In</title>
        <style>
          body {
            font-family: -apple-system, sans-serif;
            max-width: 500px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h2 { margin: 0 0 10px 0; color: #333; }
          .subtitle { color: #666; margin: 0 0 20px 0; font-size: 14px; }
          label { display: block; margin: 15px 0 5px 0; font-weight: 600; color: #333; }
          input[type=range] { width: 100%; cursor: pointer; }
          input[type=number] {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
          }
          .hint { font-size: 12px; color: #666; margin: 5px 0 0 0; }
          textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
          }
          button {
            background: #007AFF;
            color: white;
            border: none;
            padding: 15px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
            font-weight: 600;
          }
          button:hover { background: #0051D5; }
          button:active { opacity: 0.8; }
          ${SCORE_ITEM_WIDGET_STYLES}
        </style>
      </head>
      <body>
        <div class="card">
          <h1><i data-lucide="clipboard-check"></i> ${escapeHtml(dog.dog_name)}'s Check-In</h1>
          <p class="subtitle">Week ${weekNumber} Health Tracker</p>

          <form id="checkinForm">
            <h2 style="font-size: 15px; font-weight: 600; color: #333; margin: 0 0 4px 0;">Mobility</h2>
            ${buildDomainItemWidgetsHtml('mobility', mobilityPrefill)}

            <h2 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Energy</h2>
            ${buildSingleItemWidgetHtml('energy', latestEnergy)}

            <h2 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Appetite</h2>
            ${buildSingleItemWidgetHtml('appetite', latestAppetite)}

            ${buildMedicationUpdateSectionHtml(activeMedications)}

            ${showCognitive ? `
            <h2 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Cognitive &amp; Behavior</h2>
            <p class="hint" style="margin: 0 0 16px 0;">Asked every 4th week.</p>
            ${buildDomainItemWidgetsHtml('cognitive', cognitivePrefill)}
            ` : ''}

            ${showCognitive ? `
            <label for="weight" style="margin-top: 20px;">${escapeHtml(dog.dog_name)}'s weight this week (lbs)</label>
            <input
              type="number"
              id="weight"
              name="weight_lbs"
              min="1"
              max="250"
              value="${latestWeight || ''}"
              placeholder="e.g. 62"
            >
            <div class="hint">Optional — tracked alongside mobility, energy, and appetite.</div>
            ` : ''}

            <label for="observation" style="margin-top: 20px;">Any notes? (optional)</label>
            <textarea
              id="observation"
              name="observation"
              placeholder="E.g., 'Easier on stairs this week' or 'Stiff in morning'"
              style="height: 80px;"
            ></textarea>

            <button type="submit" style="background: #A89968; color: white; border: none; padding: 15px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 20px; font-weight: 500;">Submit Check-In ✓</button>
          </form>
        </div>

        <script>
          ${SCORE_ITEM_WIDGET_SCRIPT}
          ${MEDICATION_UPDATE_SCRIPT}

          document.getElementById('checkinForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const scoreCheck = formHasAllScoreItemsAnswered(e.target);
            if (!scoreCheck.valid) {
              highlightUnansweredScoreItem(scoreCheck.firstInvalid);
              return;
            }

            const medCheck = medicationUpdateSectionIsValid();
            if (!medCheck.valid) {
              alert(medCheck.message);
              return;
            }

            const formData = new FormData(e.target);
            const medAnswer = formData.get('medication_update_answer');
            try {
              const response = await fetch('/api/checkin-senior', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  dog_id: '${dog_id}',
                  mobility_getting_up: parseInt(formData.get('mobility_getting_up')),
                  mobility_stairs: parseInt(formData.get('mobility_stairs')),
                  mobility_stiffness_after_rest: parseInt(formData.get('mobility_stiffness_after_rest')),
                  mobility_walk_distance: parseInt(formData.get('mobility_walk_distance')),
                  energy_score: parseInt(formData.get('energy_score')),
                  appetite_score: parseInt(formData.get('appetite_score')),
                  cognitive_orientation: formData.get('cognitive_orientation') ? parseInt(formData.get('cognitive_orientation')) : null,
                  cognitive_memory: formData.get('cognitive_memory') ? parseInt(formData.get('cognitive_memory')) : null,
                  cognitive_interest: formData.get('cognitive_interest') ? parseInt(formData.get('cognitive_interest')) : null,
                  cognitive_sleep_wake: formData.get('cognitive_sleep_wake') ? parseInt(formData.get('cognitive_sleep_wake')) : null,
                  weight_lbs: formData.get('weight_lbs') ? parseInt(formData.get('weight_lbs')) : null,
                  observation: formData.get('observation') || null,
                  medication_id: medAnswer === 'yes' ? (formData.get('medication_id') || null) : null,
                  medication_change_type: medAnswer === 'yes' ? (formData.get('medication_change_type') || null) : null,
                  medication_update_note: medAnswer === 'yes' ? (formData.get('medication_update_note') || null) : null
                })
              });

              const result = await response.json();

              if (result.success) {
                const streakBadge = result.current_streak > 1 ? \`
                  <div style="background: #FFF3E0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; display: inline-block;">
                    <i data-lucide="flame" style="width: 20px; height: 20px; vertical-align: middle;"></i>
                    <span style="font-size: 16px; font-weight: 600; color: #E65100;">\${result.current_streak} week streak</span>
                  </div>
                \` : '';

                const milestoneBanner = result.milestone_message ? \`
                  <p style="font-size: 14px; color: #2E7D32; font-weight: 600; margin: 12px 0; background: #E8F5E9; border-radius: 8px; padding: 10px;">
                    <i data-lucide="award" style="width: 1em; height: 1em; vertical-align: -0.15em;"></i> \${result.milestone_message}
                  </p>
                \` : '';

                const cognitiveWeekNote = result.was_cognitive_week ? \`
                  <p style="font-size: 13px; color: #555; margin: 12px 0; background: #F5F5F5; border-radius: 8px; padding: 8px 10px;">
                    Also logged: weight and cognitive/behavior — thanks for the extra detail this week.
                  </p>
                \` : '';

                document.body.innerHTML = \`
                  <div class="card" style="text-align: center;">
                    <h2 style="color: green;">✅ Check-In Submitted!</h2>
                    <p style="font-size: 18px; color: #007AFF; margin: 20px 0;">
                      ${escapeHtml(dog.dog_name)}'s mobility: \${result.mobility_score}/10
                    </p>
                    \${streakBadge}
                    \${milestoneBanner}
                    \${cognitiveWeekNote}
                    <p style="font-size: 14px; color: #666; margin: 20px 0;">
                      \${result.change_text}
                    </p>
                    <a href="/dashboard/${dog_id}" style="display: inline-block; background: #007AFF; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; margin: 8px 0 20px 0;">View Dashboard</a>
                    <p style="font-size: 12px; color: #999;">
                      You'll get SMS updates each week. Thanks for tracking!
                    </p>
                  </div>
                \`;
                lucide.createIcons({ attrs: { width: '1em', height: '1em' } });
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error submitting check-in. Please try again.');
            }
          });
        </script>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error in check-in form:', error);
    res.status(500).send('Error loading check-in form');
  }
});

// ============================================
// SENIOR DOGS MOBILITY: SAVE CHECK-IN DATA
// NEW ENDPOINT - STEP 5 (companion to STEP 4)
// ============================================
// ============================================
// STEP 27B: POST-LOG MICRO-INSIGHTS
// Compares this week's 4 scores to last week's (or baseline, for cognitive
// on weeks it wasn't asked) and writes a sentence about whichever metric
// actually moved the most — not always mobility.
// ============================================
function generatePostLogInsight(dogName, current, previous) {
  // current/previous are objects: { mobility, energy, appetite, cognitive }
  // previous.cognitive may be null if no prior weekly cognitive score exists —
  // caller is responsible for passing baseline_cognitive_score as the fallback in that case.

  const metrics = [
    { key: 'mobility', label: 'mobility' },
    { key: 'energy', label: 'energy' },
    { key: 'appetite', label: 'appetite' },
    { key: 'cognitive', label: 'cognitive sharpness' }
  ];

  // Build a diff for each metric we actually have both values for
  const diffs = metrics
    .filter(m => current[m.key] != null && previous[m.key] != null)
    .map(m => ({
      ...m,
      diff: current[m.key] - previous[m.key],
      currentVal: current[m.key]
    }));

  if (diffs.length === 0) {
    // Shouldn't normally happen (mobility/energy/appetite are always required),
    // but guard against it rather than crash.
    return `Thanks for logging ${dogName}'s check-in this week!`;
  }

  // Find the metric with the biggest absolute change
  const biggest = diffs.reduce((a, b) => (Math.abs(b.diff) > Math.abs(a.diff) ? b : a));

  // Everything flat — no metric moved
  if (biggest.diff === 0) {
    const flatVariants = [
      `${dogName}'s scores held steady across the board this week. Consistency like this makes patterns easier to spot down the line.`,
      `No major changes for ${dogName} this week — steady weeks matter too. Keep the check-ins coming.`,
      `${dogName} looks about the same as last week. That stability itself is worth tracking over time.`
    ];
    return flatVariants[Math.floor(Math.random() * flatVariants.length)];
  }

  // STEP P10: higher = more concerning now, so a score DECREASE is the
  // encouraging outcome and a score INCREASE is the one worth a cautious
  // note — the opposite of the old 1-8 scale. Not a bare swap of which
  // variant array fires: the words inside each variant describe the raw
  // number's motion ("up"/"down"/"dropped"/"lower"), and those need to
  // stay factually true to what actually happened, so each array's
  // internal wording is rewritten to match its real direction, not just
  // reassigned. See docs/Health_Instrument_Redesign_Build.md Stage 4a spec.
  const sentiment = biggest.diff < 0 ? 'better' : 'worse';
  const absDiff = roundToOneDecimal(Math.abs(biggest.diff));

  const betterVariants = [
    `${dogName}'s ${biggest.label} is down ${absDiff} point${absDiff > 1 ? 's' : ''} from last week. Keep logging to see how the trend continues.`,
    `${dogName}'s ${biggest.label} moved lower by ${absDiff} point${absDiff > 1 ? 's' : ''} since last week — worth adding a note in the dashboard if anything's changed.`,
    `${dogName}'s ${biggest.label} was lower this week (-${absDiff}). One week alone isn't a pattern — tracking it is how you'll know.`
  ];

  const worseVariants = [
    `${dogName}'s ${biggest.label} is up ${absDiff} point${absDiff > 1 ? 's' : ''} from last week. One week alone doesn't show a pattern — keep logging, and add a note in the dashboard if anything's changed.`,
    `${dogName}'s ${biggest.label} increased by ${absDiff} point${absDiff > 1 ? 's' : ''} since last week. Keep logging so you can see if it's a trend or a one-off.`,
    `${dogName}'s ${biggest.label} was a bit higher this week (+${absDiff}). One week alone isn't a pattern — tracking it is how you'll know.`
  ];

  const variants = sentiment === 'better' ? betterVariants : worseVariants;
  return variants[Math.floor(Math.random() * variants.length)];
}

// ============================================
// STEP 27C: STREAK GAMIFICATION
// current_streak is deliberately NOT stored anywhere — it's calculated
// live from mobility_checkins, same logic the dashboard already uses.
// This function is the single shared source of truth for that calculation
// so the dashboard and the check-in endpoint can never disagree.
// ============================================
async function calculateCurrentStreak(dog_id) {
  const { data: checkins } = await supabase
    .from('mobility_checkins')
    .select('week_number')
    .eq('dog_id', dog_id);

  if (!checkins || checkins.length === 0) return 0;

  let streak = 0;
  const sortedByWeek = [...checkins].sort((a, b) => b.week_number - a.week_number);
  // Defensive floor: a stray week_number of 0 or less (bad data, clock skew,
  // pre-fix legacy rows) shouldn't make the countdown loop skip entirely.
  const maxWeek = Math.max(1, sortedByWeek[0].week_number);
  for (let i = maxWeek; i >= 1; i--) {
    const hasWeek = checkins.some(c => c.week_number === i);
    if (hasWeek) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Returns a milestone message for round-number streaks, or null on
// non-milestone weeks (so the front end can just not show anything extra).
//
// Retention discussion, Aug 24: this used to go silent past streak 12 —
// nothing in the app's original 12-week design anticipated a dog logging
// longer than that, so no entry existed and every later milestone quietly
// showed nothing. 26 (six months) and 52 (one year) get real, hand-written
// copy matching the register of the original four; every OTHER 4-week
// milestone beyond 12 (16, 20, 24, 28, ...) gets a simple templated message
// instead of a hardcoded table entry, so this never needs manual upkeep
// again and streaks never go silent a second time.
function getStreakMilestoneMessage(dogName, streak) {
  const milestones = {
    2: `2 weeks in a row for ${dogName}! You're building a real health journey.`,
    4: `${dogName}'s first month of consistent tracking — 4 weeks straight!`,
    8: `8-week streak for ${dogName}. Patterns are getting clearer with every check-in.`,
    12: `${dogName} made it a full 12 weeks! This is exactly the kind of consistency that builds a real picture of ${dogName}'s health over time.`,
    26: `${dogName} just crossed six months of consistent logging — 26 weeks straight. That's a real, lasting health record.`,
    52: `${dogName} completed a full year of logging — 52 weeks straight. That's an exceptional, genuinely rare health record.`
  };
  if (milestones[streak]) return milestones[streak];
  if (streak > 12 && streak % 4 === 0) {
    return `${dogName} just hit ${streak} weeks in a row. Every week adds more to a real, lasting picture of ${dogName}'s health.`;
  }
  return null;
}

// ============================================
// STEP 27D: HEALTH ALERT TRIGGERS
// Dashboard-only (no SMS). De-dupes per dog+metric+direction within a
// 14-day window so owners aren't shown the same alert repeatedly.
//
// STEP P10 threshold retune — see docs/Health_Instrument_Redesign_Build.md
// Stage 1 decisions table for the full reasoning. Averaging inherently
// dampens movement (a 4-point single-item swing among 4 items only moves
// the composite by 1.0), so mobility/cognitive get TWO independent checks
// instead of one composite-only threshold: the composite itself moving
// HEALTH_ALERT_COMPOSITE_THRESHOLD+, OR any single item moving
// HEALTH_ALERT_ITEM_THRESHOLD+ on its own — which catches a real
// single-domain spike (e.g. Stairs got much worse, everything else flat)
// that a composite-only check would miss entirely. Energy/appetite (single
// values, no averaging) keep one direct threshold, proportionally scaled
// from the old 2-points-of-8 to HEALTH_ALERT_SINGLE_VALUE_THRESHOLD
// (3-points-of-10). All three numbers are still provisional guesses
// pending real-data tuning, same as the original.
// ============================================
const HEALTH_ALERT_COMPOSITE_THRESHOLD = 1.0;
const HEALTH_ALERT_ITEM_THRESHOLD = 3;
const HEALTH_ALERT_SINGLE_VALUE_THRESHOLD = 3;
const HEALTH_ALERT_DEDUP_DAYS = 14;

const HEALTH_ALERT_ITEM_LABELS = {
  mobility: { getting_up: 'Getting Up', stairs: 'Stairs', stiffness_after_rest: 'Stiffness After Rest', walk_distance: 'Walk Distance' },
  cognitive: { orientation: 'Orientation', memory: 'Memory/Recognition', interest: 'Interest/Engagement', sleep_wake: 'Sleep-Wake Pattern' }
};

// currentItems/previousItems are only populated for mobility/cognitive
// (the two domains with items) — shape: { mobility: {getting_up, stairs,
// stiffness_after_rest, walk_distance} | undefined, cognitive: {...} |
// undefined }. Absent/undefined for a domain simply skips the item-level
// check for it (e.g. on a non-cadence week, cognitive has no items to check).
async function detectHealthAlerts(dog_id, dogName, current, previous, currentItems, previousItems) {
  const metrics = [
    { key: 'mobility', label: 'mobility', hasItems: true },
    { key: 'energy', label: 'energy', hasItems: false },
    { key: 'appetite', label: 'appetite', hasItems: false },
    { key: 'cognitive', label: 'cognitive sharpness', hasItems: true }
  ];

  const fourteenDaysAgo = new Date(Date.now() - HEALTH_ALERT_DEDUP_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (const m of metrics) {
    if (current[m.key] == null || previous[m.key] == null) continue;

    const compositeDiff = current[m.key] - previous[m.key];

    // Find the single item (if any) with the largest movement past its own
    // threshold — more specific and, per the Stage 1 reasoning, a better
    // trigger than the composite alone when a real single-domain change is
    // hiding inside an otherwise-flat average.
    let biggestItem = null; // { key, label, diff }
    if (m.hasItems && currentItems?.[m.key] && previousItems?.[m.key]) {
      for (const itemKey of Object.keys(currentItems[m.key])) {
        const curVal = currentItems[m.key][itemKey];
        const prevVal = previousItems[m.key][itemKey];
        if (curVal == null || prevVal == null) continue;
        const itemDiff = curVal - prevVal;
        if (Math.abs(itemDiff) < HEALTH_ALERT_ITEM_THRESHOLD) continue;
        if (!biggestItem || Math.abs(itemDiff) > Math.abs(biggestItem.diff)) {
          biggestItem = { key: itemKey, label: HEALTH_ALERT_ITEM_LABELS[m.key]?.[itemKey] || itemKey, diff: itemDiff };
        }
      }
    }

    const compositeThreshold = m.hasItems ? HEALTH_ALERT_COMPOSITE_THRESHOLD : HEALTH_ALERT_SINGLE_VALUE_THRESHOLD;
    const compositeTriggered = Math.abs(compositeDiff) >= compositeThreshold;

    if (!compositeTriggered && !biggestItem) continue; // neither check crossed threshold

    // Prefer the item-level trigger for the message when it's the larger/
    // more specific signal — more useful to the owner than a vague
    // domain-wide note, and a stronger future trigger for STEP 27E's
    // confounder-branching questions.
    const useItem = biggestItem && (!compositeTriggered || Math.abs(biggestItem.diff) > Math.abs(compositeDiff));
    const triggerDiff = useItem ? biggestItem.diff : compositeDiff;
    const direction = triggerDiff > 0 ? 'up' : 'down';
    // Rounded: item-triggered magnitudes are always whole numbers already,
    // but a composite-only magnitude is an average-of-4 and can be
    // fractional with raw float noise (e.g. 1.2000000000000002) — this
    // both displays clean and is what gets stored in health_alerts.magnitude
    // (see migration_widen_health_alert_magnitude.sql).
    const magnitude = roundToOneDecimal(Math.abs(triggerDiff));
    const subject = useItem ? biggestItem.label : m.label;

    // De-dup: skip if this dog already got an alert for this exact metric AND
    // direction within the last 14 days. Direction-specific on purpose — a
    // decline alert shouldn't suppress a later improvement alert for the same
    // metric (a recovery is worth surfacing even if a drop fired recently).
    // Still keyed by domain (metric), not per-item — health_alerts has no
    // item-level column, and adding one is a schema change out of scope for
    // this stage; an item-triggered alert is still stored under its
    // domain's metric key, with a message naming the specific item.
    const { data: recentAlerts } = await supabase
      .from('health_alerts')
      .select('id')
      .eq('dog_id', dog_id)
      .eq('metric', m.key)
      .eq('direction', direction)
      .gte('created_at', fourteenDaysAgo)
      .limit(1);

    if (recentAlerts && recentAlerts.length > 0) continue; // already alerted recently

    // SAFE, non-diagnostic framing — no treatment claims, always points to the vet.
    // See project compliance framework: observational only, never interprets
    // what a change "means" medically.
    //
    // STEP P10: higher = more concerning now, so the vet-mention/concerning
    // template fires on direction === 'up' (score rose) and the down-
    // direction template fires on 'down' (score fell) — flipped from the
    // old scale. `direction` itself is UNCHANGED: it's still a literal
    // description of which way the raw number moved, used only as a stable
    // dedup bucket key, not a "good/bad" label.
    //
    // Neutral-language fix: the down-direction template used to say
    // "improved" here -- evaluative language that conflicted with this
    // project's own standing rule (never interpret/diagnose) and with the
    // neutral-descriptor convention buildHealthSummary() established.
    // "decreased" is factual and directional (same status as "increased"
    // on the other branch) without judging the change as good or bad.
    // The asymmetric call-to-action (vet-mention on 'up', a dashboard note
    // on 'down') is INTENTIONALLY kept -- confirmed with John this reflects
    // which direction is more plausibly vet-relevant, not a value judgment,
    // and doesn't depend on "improved" to be justified.
    const pointWord = magnitude === 1 ? 'point' : 'points';
    const message = direction === 'up'
      ? `${dogName}'s ${subject} increased ${magnitude} ${pointWord} compared to a recent check-in. This is not a diagnosis. It reflects a reported change — consult your veterinarian with any concerns.`
      : `${dogName}'s ${subject} decreased ${magnitude} ${pointWord} compared to a recent check-in. If anything's changed recently, consider adding a note in the dashboard.`;

    const { error: alertError } = await supabase
      .from('health_alerts')
      .insert({
        dog_id: dog_id,
        metric: m.key,
        direction: direction,
        magnitude: magnitude,
        message: message
      });

    if (alertError) console.warn(`⚠️ Error saving health alert for ${m.key}:`, alertError);
  }
}

app.post('/api/checkin-senior', async (req, res) => {
  try {
    const {
      dog_id,
      mobility_getting_up,
      mobility_stairs,
      mobility_stiffness_after_rest,
      mobility_walk_distance,
      energy_score,
      appetite_score,
      cognitive_orientation,
      cognitive_memory,
      cognitive_interest,
      cognitive_sleep_wake,
      weight_lbs,
      observation,
      medication_id,
      medication_change_type,
      medication_update_note
    } = req.body;

    if (!dog_id) {
      return res.status(400).json({ success: false, error: 'Missing required field: dog_id' });
    }

    // STEP P10 instrument: mobility is 4 items, always required (asked every
    // week). Energy/appetite stay single 0-10 values, always required.
    // Cognitive is an all-or-nothing 4-item bundle, only actually sent by
    // the client on a 4th-week cadence submission (see showCognitive on the
    // check-in page / showCognitiveThisWeek on the dashboard modal) — but
    // this endpoint doesn't itself enforce that cadence, matching the OLD
    // single-slider version's behavior exactly: it only ever cared whether
    // cognitive was present at all, never which week it was (see
    // docs/Health_Instrument_Redesign_Build.md Stage 3). Do NOT use `!value`
    // truthy checks anywhere on these fields — 0 is a valid, common answer
    // ("no difficulty") on this scale, and `!0` is true in JS.
    const mobilityItemValues = [mobility_getting_up, mobility_stairs, mobility_stiffness_after_rest, mobility_walk_distance];
    if (mobilityItemValues.some(v => !isValidInstrumentValue(v))) {
      return res.status(400).json({
        success: false,
        error: 'Each mobility item must be a whole number from 0 to 10'
      });
    }
    if (!isValidInstrumentValue(energy_score)) {
      return res.status(400).json({
        success: false,
        error: 'Energy score must be a whole number from 0 to 10'
      });
    }
    if (!isValidInstrumentValue(appetite_score)) {
      return res.status(400).json({
        success: false,
        error: 'Appetite score must be a whole number from 0 to 10'
      });
    }

    const cleanMobilityItems = mobilityItemValues.map(Number);
    const mobilityComposite = computeCompositeScore(cleanMobilityItems);
    const cleanEnergy = Number(energy_score);
    const cleanAppetite = Number(appetite_score);

    // Cognitive: none provided -> not a cadence week, store all null.
    // Some-but-not-all provided -> a malformed submission, reject it rather
    // than silently discarding partial answers. All 4 provided -> validate
    // and composite, same shape as mobility.
    const cognitiveItemValues = [cognitive_orientation, cognitive_memory, cognitive_interest, cognitive_sleep_wake];
    const cognitiveProvidedCount = cognitiveItemValues.filter(v => v !== undefined && v !== null && v !== '').length;
    let cleanCognitiveItems = [null, null, null, null];
    let cognitiveComposite = null;
    if (cognitiveProvidedCount > 0) {
      if (cognitiveProvidedCount < 4 || cognitiveItemValues.some(v => !isValidInstrumentValue(v))) {
        return res.status(400).json({
          success: false,
          error: 'If submitting cognitive/behavior this week, all 4 items must be a whole number from 0 to 10'
        });
      }
      cleanCognitiveItems = cognitiveItemValues.map(Number);
      cognitiveComposite = computeCompositeScore(cleanCognitiveItems);
    }

    // Weight is also only asked every 4th week, same trigger as cognitive —
    // optional here too, and validated against the same 1-250 range used
    // for the one-time baseline weight at signup.
    let weightLbsInt = null;
    if (weight_lbs !== undefined && weight_lbs !== null && weight_lbs !== '') {
      weightLbsInt = parseInt(weight_lbs);
      if (isNaN(weightLbsInt) || weightLbsInt < 1 || weightLbsInt > 250) {
        return res.status(400).json({
          success: false,
          error: 'Weight must be a number between 1 and 250 lbs'
        });
      }
    }

    // Get the dog info
    const { data: dog } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (!dog) {
      return res.status(404).json({
        success: false,
        error: 'Dog not found'
      });
    }

    // STEP: Real enforcement of the 7-day baseline gate. Blocking the page
    // isn't enough on its own — this is the actual save endpoint, so this
    // is the check that actually matters. Someone POSTing here directly
    // (bypassing the page) still can't save an early check-in.
    const daysSinceSignupForSave = (new Date() - new Date(dog.created_at)) / (24 * 60 * 60 * 1000);
    if (Math.floor(daysSinceSignupForSave / 7) === 0) {
      return res.status(403).json({
        success: false,
        error: `${dog.dog_name}'s first weekly update isn't available yet — it opens up 7 days after signing up.`
      });
    }

    // Calculate week number based on when dog was created
    const created = new Date(dog.created_at);
    const now = new Date();
    // Floor at week 1 — matches the same safety clamp already used on the
    // check-in display page. Without this, clock skew or a created_at that's
    // slightly in the future (found during 27C testing) can save week_number
    // as 0 or negative, which silently breaks streak counting downstream.
    const weekNumber = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    // Real enforcement of "one check-in per dog per week" — the page-level
    // guard above blocks the normal path, but this is the actual save
    // endpoint, so this is the check that actually matters. Found via real
    // live-device testing (Aug 24): with no guard here, revisiting the same
    // check-in link within the same computed week (e.g. an old reminder
    // text tapped a second time) silently inserted a second mobility_checkins
    // row for the same dog+week, rather than being rejected or treated as an
    // update. Same pattern as the baseline-period gate just above.
    const { data: existingWeekCheckin } = await supabase
      .from('mobility_checkins')
      .select('id')
      .eq('dog_id', dog_id)
      .eq('week_number', weekNumber)
      .limit(1);
    if (existingWeekCheckin && existingWeekCheckin.length > 0) {
      return res.status(409).json({
        success: false,
        error: `${dog.dog_name} already has a check-in recorded for week ${weekNumber}. Come back next week for the next update!`
      });
    }

    // Get previous check-in for comparison — pulling all 4 composites AND the
    // 8 item columns now, so the post-log insight (STEP 27B) can comment on
    // whichever metric actually moved most, and detectHealthAlerts (STEP 27D)
    // can check individual items, not just composites.
    const { data: prevCheckins } = await supabase
      .from('mobility_checkins')
      .select('mobility_score, energy_score, appetite_score, cognitive_score, mobility_getting_up, mobility_stairs, mobility_stiffness_after_rest, mobility_walk_distance, cognitive_orientation, cognitive_memory, cognitive_interest, cognitive_sleep_wake')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false })
      .limit(1);

    // ?? not || — under the old 1-8 scale mobility_score could never be 0,
    // so they were equivalent, but 0 is a fully legitimate value on the new
    // 0-10 scale (a perfectly healthy week). || would silently discard a
    // real 0 and fall back to baseline instead. Found in Stage 4a review.
    const previousScore = prevCheckins?.[0]?.mobility_score ?? dog.baseline_mobility_score;
    const scoreDiff = mobilityComposite - previousScore;

    // Determine segment (A=improving, B=flat, C=declining). STEP P10: higher
    // now = more concerning, so a NEGATIVE scoreDiff (score fell) is the
    // improving case — flipped from the old 1-8 scale, where a positive
    // diff meant genuine improvement.
    let segment = 'B'; // default moderate
    if (scoreDiff <= -1) segment = 'A'; // improving
    if (scoreDiff >= 1) segment = 'C'; // declining

    // ============================================
    // CAPTURE SUBMISSION TIME & CALCULATE REMINDER PREFERENCE
    // ============================================
    const submissionTime = new Date();
    const submissionDayOfWeek = submissionTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    // Determine reminder time based on day of week
    let reminderTime = '07:30'; // default weekday
    if (submissionDayOfWeek === 0 || submissionDayOfWeek === 6) {
      // Weekend (Saturday=6, Sunday=0)
      reminderTime = '14:00'; // 2:00 PM
    }
    // Weekday (Mon-Fri) uses 7:30 AM

    // Update dog's preferred reminder day and time
    const { error: updateError } = await supabase
      .from('senior_dogs')
      .update({
        preferred_reminder_day: submissionDayOfWeek,
        preferred_reminder_time: reminderTime
      })
      .eq('id', dog_id);

    if (updateError) console.warn('⚠️ Error updating reminder preference:', updateError);

    // Save check-in to database
    const { data: checkin, error: saveError } = await supabase
      .from('mobility_checkins')
      .insert({
        dog_id: dog_id,
        week_number: weekNumber,
        mobility_getting_up: cleanMobilityItems[0],
        mobility_stairs: cleanMobilityItems[1],
        mobility_stiffness_after_rest: cleanMobilityItems[2],
        mobility_walk_distance: cleanMobilityItems[3],
        mobility_score: mobilityComposite,
        energy_score: cleanEnergy,
        appetite_score: cleanAppetite,
        cognitive_orientation: cleanCognitiveItems[0],
        cognitive_memory: cleanCognitiveItems[1],
        cognitive_interest: cleanCognitiveItems[2],
        cognitive_sleep_wake: cleanCognitiveItems[3],
        cognitive_score: cognitiveComposite,
        weight_lbs: weightLbsInt,
        observation: observation || null,
        segment: segment
      });

    if (saveError) throw saveError;

    // ============================================
    // MEDICATION WEEKLY UPDATE (optional -- only present when the
    // check-in form's progressive-disclosure medication section was
    // answered "yes"). Non-blocking: a problem here shouldn't fail the
    // whole check-in submission, which is the more important data to not
    // lose -- same "don't let a secondary write sink the primary one"
    // reasoning already applied to the SMS queue / Sheets export below.
    // ============================================
    if (medication_change_type) {
      try {
        if (!MEDICATION_CHANGE_TYPES.includes(medication_change_type)) {
          console.warn(`⚠️ Invalid medication_change_type "${medication_change_type}" for dog ${dog_id}, skipping medication update`);
        } else {
          const activeMeds = await getActiveMedicationsForDog(dog_id);
          let targetMedicationId = medication_id || null;

          if (targetMedicationId) {
            // Must actually be one of this dog's own active medications --
            // never trust a client-supplied ID blindly (could be a typo,
            // a stale ID from a since-stopped medication, or someone
            // else's dog entirely).
            if (!activeMeds.some(m => m.id === targetMedicationId)) {
              console.warn(`⚠️ medication_id ${targetMedicationId} is not an active medication for dog ${dog_id}, skipping medication update`);
              targetMedicationId = null;
            }
          } else if (activeMeds.length === 1) {
            // No medication_id sent -- only valid when there's exactly one
            // active medication to auto-attribute to (the single-toggle
            // UX case). 0 or 2+ active with no ID is a malformed request.
            targetMedicationId = activeMeds[0].id;
          }

          if (targetMedicationId) {
            const cleanNote = medication_update_note ? sanitizeString(medication_update_note, 200) : null;
            const { error: medUpdateError } = await supabase
              .from('medication_weekly_updates')
              .insert({
                medication_id: targetMedicationId,
                week_number: weekNumber,
                change_type: medication_change_type,
                note: cleanNote || null
              });
            if (medUpdateError) {
              console.error(`❌ Error saving medication weekly update for dog ${dog_id}:`, medUpdateError.message);
            } else if (medication_change_type === 'stopped') {
              await stopMedication(targetMedicationId);
            }
          } else {
            console.warn(`⚠️ Could not determine which medication to attribute the update to for dog ${dog_id} (0 or 2+ active with no medication_id) — skipped`);
          }
        }
      } catch (medError) {
        console.error(`❌ Unexpected error processing medication update for dog ${dog_id}:`, medError.message);
      }
    }

    // ============================================
    // STEP 27C: UPDATE STREAK (current is live-calculated, only longest is stored)
    // ============================================
    const currentStreak = await calculateCurrentStreak(dog_id);
    let longestStreak = dog.longest_streak || 0;

    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
      const { error: streakError } = await supabase
        .from('senior_dogs')
        .update({ longest_streak: longestStreak })
        .eq('id', dog_id);
      if (streakError) console.warn('⚠️ Error updating longest_streak:', streakError);
    }

    const milestoneMessage = getStreakMilestoneMessage(dog.dog_name, currentStreak);

    // ============================================
    // QUEUE NEXT WEEK'S SMS AT PERSONALIZED TIME
    // ============================================
    const nextReminderDate = getNextReminderDate(submissionDayOfWeek, reminderTime);
    const nextCheckinLink = `${BASE_URL}/check-in/${dog_id}`;

    // Only queue a reminder text if this owner actually opted in to SMS reminders.
    if (dog.sms_consent && dog.phone) {
      const { error: queueError } = await supabase
        .from('sms_queue')
        .insert([{
          pet_id: dog_id,
          owner_id: dog.owner_id || null,
          phone: dog.phone,
          message_type: `week_${weekNumber + 1}_checkin`,
          scheduled_for: nextReminderDate.toISOString(),
          message_body: `${dog.dog_name}'s week #${weekNumber + 1} check-in: ${nextCheckinLink}`,
          status: 'pending'
        }]);

      if (queueError) console.warn('⚠️ Error queueing next reminder:', queueError);
      console.log(`📅 Next reminder for ${dog.dog_name} scheduled: ${nextReminderDate.toLocaleString()} (${getDayName(submissionDayOfWeek)} at ${reminderTime})`);
    } else {
      console.log(`📅 Skipping reminder queue for ${dog.dog_name} — SMS consent not given`);
    }

    // Generate feedback message (STEP 27B: Post-Log Micro-Insights)
    // Compares all 4 metrics against last week (cognitive falls back to baseline
    // on weeks it isn't asked, since it's only collected every 4th week).
    const prevRow = prevCheckins?.[0];
    const currentScores = {
      mobility: mobilityComposite,
      energy: cleanEnergy,
      appetite: cleanAppetite,
      cognitive: cognitiveComposite // null on non-4th weeks, that's fine — diff just skips it
    };
    const previousScores = {
      mobility: prevRow?.mobility_score ?? dog.baseline_mobility_score,
      energy: prevRow?.energy_score ?? dog.baseline_energy_score,
      appetite: prevRow?.appetite_score ?? dog.baseline_appetite_score,
      cognitive: prevRow?.cognitive_score ?? dog.baseline_cognitive_score
    };

    const changeText = generatePostLogInsight(dog.dog_name, currentScores, previousScores);

    // STEP P10: item-level current/previous, for detectHealthAlerts' per-item
    // threshold check (see its own comment for why composite-only isn't
    // enough). Mobility items are always present this week; cognitive items
    // are only built when this submission actually included them (a
    // cadence week) — detectHealthAlerts skips the item-level check
    // entirely when currentItems.cognitive is undefined.
    const currentItems = {
      mobility: {
        getting_up: cleanMobilityItems[0],
        stairs: cleanMobilityItems[1],
        stiffness_after_rest: cleanMobilityItems[2],
        walk_distance: cleanMobilityItems[3]
      },
      cognitive: cognitiveComposite != null ? {
        orientation: cleanCognitiveItems[0],
        memory: cleanCognitiveItems[1],
        interest: cleanCognitiveItems[2],
        sleep_wake: cleanCognitiveItems[3]
      } : undefined
    };
    const previousItems = {
      mobility: {
        getting_up: prevRow?.mobility_getting_up ?? dog.baseline_mobility_getting_up,
        stairs: prevRow?.mobility_stairs ?? dog.baseline_mobility_stairs,
        stiffness_after_rest: prevRow?.mobility_stiffness_after_rest ?? dog.baseline_mobility_stiffness_after_rest,
        walk_distance: prevRow?.mobility_walk_distance ?? dog.baseline_mobility_walk_distance
      },
      cognitive: {
        orientation: prevRow?.cognitive_orientation ?? dog.baseline_cognitive_orientation,
        memory: prevRow?.cognitive_memory ?? dog.baseline_cognitive_memory,
        interest: prevRow?.cognitive_interest ?? dog.baseline_cognitive_interest,
        sleep_wake: prevRow?.cognitive_sleep_wake ?? dog.baseline_cognitive_sleep_wake
      }
    };

    // STEP 27D: Health Alert Triggers — dashboard-only, no SMS. Runs after
    // the insight so it reuses the same current/previous data. Doesn't block
    // or affect the response either way — alerts show up on next dashboard load.
    await detectHealthAlerts(dog_id, dog.dog_name, currentScores, previousScores, currentItems, previousItems);

    // Export to Google Sheets (CheckIns tab) — real-time, one row per
    // check-in. Doesn't block or affect the response if this fails.
    await appendRowToSheet('CheckIns', [
      new Date().toISOString(),
      dog_id,
      dog.dog_name || '',
      weekNumber,
      currentScores.mobility ?? '',
      currentScores.energy ?? '',
      currentScores.appetite ?? '',
      currentScores.cognitive ?? '',
      weightLbsInt ?? '',
      observation || ''
    ]);

    console.log(`✅ Week ${weekNumber} check-in saved for ${dog.dog_name}`);
    console.log(`🔥 Current streak: ${currentStreak}, longest: ${longestStreak}`);

    res.json({
      success: true,
      mobility_score: mobilityComposite,
      weight_lbs: weightLbsInt,
      change_text: changeText,
      week_number: weekNumber,
      segment: segment,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      milestone_message: milestoneMessage,
      was_cognitive_week: weekNumber % 4 === 0
    });

  } catch (error) {
    console.error('Error saving check-in:', error);
    res.status(500).json({
      success: false,
      error: 'Error saving check-in',
      details: error.message
    });
  }
});

// ============================================
// SENIOR DOGS MOBILITY: DASHBOARD
// NEW ENDPOINT - STEP 7
// Displays: mobility score, trend, streak, peer comparison with Chart.js
// ============================================
// ============================================
// STEP P1D: CONTENT REWARDS (Tier 1 — Breed History)
// Static content, no AI generation, no cohort comparisons — deliberately
// scoped down from the original spec, which called for AI-generated guides
// with "compared to X other dogs on this platform" claims. That kind of
// claim needs a real breed cohort to be honest, and there are zero real
// founding members yet. This version uses only general, well-established
// breed knowledge and shows the dog's OWN score neutrally, never compared
// to other users. Add the cohort-comparison layer once P1C's blocker clears.
//
// Unlock state is NOT stored anywhere — same pattern as current_streak.
// "Unlocked" just means "this dog's current week is >= 2," computed live
// from the same week-number logic already used elsewhere, so there's
// nothing that can drift out of sync.
// ============================================
const BREED_GUIDES = {
  // ===== Larger breeds =====
  'labrador': {
    displayName: 'Labrador Retriever',
    typicalWeight: '55–80 lb',
    history: `Labrador Retrievers originated in Newfoundland, Canada, where they worked alongside fishermen retrieving nets and catch from icy water. Their name comes from the nearby Labrador Sea. They were brought to England in the 1800s, refined into the breed known today, and have been one of the most popular family dogs for decades.`,
    temperament: `Labs are known for being friendly, outgoing, and eager to please — traits that made them natural fits as family companions, service dogs, and working retrievers. They tend to stay playful well into their senior years, though most slow down noticeably by age 9-10.`,
    seniorPatterns: `As Labs age, joint health is one of the most commonly discussed topics among owners, given the breed's size and activity level earlier in life. Morning stiffness, a preference for shorter walks, and more careful movement on stairs are all commonly reported by owners of senior Labs. This isn't universal, and every dog ages differently — but it's a pattern worth being aware of and worth mentioning to your vet if you notice it.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance coat, but sheds heavily year-round', averageLifespan: '10–12 years' },
    exercise: `Labs were bred to work in the field for hours at a stretch, and that heritage still shows up in most of them — many do best with real daily exercise, whether that's a long walk, a swim, or a solid game of fetch. As Labs get older, a lot of owners find themselves naturally shifting toward shorter, more frequent outings instead of one long session. Tracking mobility over time is one way to see that shift as a real pattern rather than just a guess.`
  },
  'golden retriever': {
    displayName: 'Golden Retriever',
    typicalWeight: '55–75 lb',
    history: `Golden Retrievers were developed in Scotland in the mid-1800s, bred specifically for retrieving waterfowl in the Scottish Highlands. Their soft mouths (for retrieving game undamaged) and warm temperament made them quickly popular beyond hunting, becoming one of the most beloved family breeds worldwide.`,
    temperament: `Goldens are known for being gentle, patient, and intelligent — qualities that make them common choices for therapy and service work. Many stay affectionate and eager to be near their people throughout their senior years.`,
    seniorPatterns: `Golden Retrievers are a breed where owners commonly discuss joint and mobility changes with age, along with skin and coat changes. Many senior Goldens do well with consistent, moderate exercise rather than high-intensity activity. As always, individual dogs vary widely — tracking your own dog's patterns over time is more useful than any breed generalization.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate-to-high — regular brushing, moderate-to-heavy shedding', averageLifespan: '10–12 years' },
    exercise: `Goldens were bred to retrieve for hours in the field, and most do best with real daily exercise — a long walk, a swim, or a good fetch session. Many naturally shift toward shorter, gentler outings as they get older, which tends to suit the breed's joints better than sudden high-impact activity. A consistent routine, rather than occasional bursts of intense exercise, is commonly recommended at any age.`
  },
  'german shepherd': {
    displayName: 'German Shepherd',
    typicalWeight: '50–90 lb',
    history: `German Shepherds were developed in Germany in the late 1800s, originally bred for herding sheep and valued for their intelligence, trainability, and versatility. Those same traits later made them a top choice for police, military, and service work worldwide.`,
    temperament: `German Shepherds are known for loyalty, confidence, and a strong working drive. They tend to bond closely with their families and often remain alert and engaged well into their senior years.`,
    seniorPatterns: `Hind-leg mobility and stability are commonly discussed topics among senior German Shepherd owners, given the breed's build. Owners often notice changes in how a dog navigates stairs or gets up after resting before other changes appear. This is general breed-level context, not a prediction for any individual dog — tracking your own dog's actual patterns is what matters most.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate-to-high — double coat sheds heavily, especially seasonally', averageLifespan: '9–13 years' },
    exercise: `German Shepherds were bred to work, and most need both physical exercise and mental engagement to stay content — a plain walk often isn't enough on its own. Training, puzzle toys, or a structured job tend to go a long way for this breed. As the breed ages, owners often find that shorter, more frequent activity sessions work better than one long outing.`
  },
  'rottweiler': {
    displayName: 'Rottweiler',
    typicalWeight: '80–135 lb',
    history: `Rottweilers trace back to Roman drover dogs used to herd cattle, later refined in the German town of Rottweil, where they were used to drive livestock to market and pull carts. Their strength and work ethic later made them popular for police and guard work.`,
    temperament: `Rottweilers are known for being confident, loyal, and protective of their families. Many remain calm and steady companions well into their senior years, though their size means mobility changes can be more noticeable.`,
    seniorPatterns: `Joint health — particularly hips and elbows — is one of the most commonly discussed topics among Rottweiler owners, given the breed's size and build. Owners often notice changes in willingness to jump, climb stairs, or rise after resting before other signs appear. Weight management is frequently discussed too, since extra weight adds real strain to large joints.`,
    atAGlance: { energyLevel: 'Moderate-to-High', grooming: 'Low-maintenance short coat', averageLifespan: '8–10 years' },
    exercise: `Rottweilers do well with regular, moderate-to-vigorous exercise and benefit from structured training alongside physical activity, given their strength and intelligence. Many owners find that consistent daily routines suit this breed better than occasional intense sessions, and that low-impact activity becomes more important as the breed's joints age.`
  },
  'german shorthaired pointer': {
    displayName: 'German Shorthaired Pointer',
    typicalWeight: '45–70 lb',
    history: `German Shorthaired Pointers were developed in Germany in the 1800s as versatile hunting dogs, bred to point, track, and retrieve across a range of terrain and game.`,
    temperament: `GSPs are known for being high-energy, intelligent, and eager to work — traits that made them prized all-purpose hunting companions. Many stay active and engaged well into their senior years, though exercise needs typically taper with age.`,
    seniorPatterns: `Joint health is a commonly discussed topic among GSP owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina or willingness for longer outings before other signs appear. Adjusting exercise intensity (not necessarily stopping it) is a common conversation senior GSP owners have with their vets.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance short coat', averageLifespan: '10–12 years' },
    exercise: `GSPs were bred for all-day fieldwork, and it shows — this is one of the higher-energy breeds here, often needing significantly more exercise than a daily walk to stay settled. Owners commonly find that under-exercised GSPs can become restless, while a dog getting real vigorous activity tends to be a much calmer companion at home.`
  },
  'cane corso': {
    displayName: 'Cane Corso',
    pronunciation: 'KAH-nay KOR-so',
    typicalWeight: '85–110 lb',
    history: `Cane Corsos descend from ancient Roman war and guard dogs, developed in southern Italy and traditionally used for guarding property and livestock. The name roughly translates to "bodyguard dog."`,
    temperament: `Cane Corsos are known for being confident, loyal, and protective, with a calm, steady demeanor in a well-socialized dog. Many remain devoted, watchful companions well into their senior years.`,
    seniorPatterns: `Given their large size, joint health — particularly hips and elbows — is a commonly discussed topic among Cane Corso owners as the breed ages. Heart health is also a frequent topic of conversation with vets for large breeds generally. Owners often find that weight management makes a real difference in comfort and mobility as these dogs get older.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Low-maintenance short coat', averageLifespan: '9–12 years' },
    exercise: `Cane Corsos generally do well with regular, moderate exercise paired with consistent training — this is a breed that benefits as much from mental structure as physical activity, given its size and intelligence. Owners often find a predictable daily routine works better than sporadic, high-intensity sessions.`
  },
  'doberman pinscher': {
    displayName: 'Doberman Pinscher',
    pronunciation: 'DOH-ber-man PIN-sher (not "pincher")',
    typicalWeight: '60–100 lb',
    history: `Doberman Pinschers were developed in Germany in the late 1800s by a tax collector who wanted a loyal, protective companion for his rounds. The breed was quickly recognized for intelligence and versatility in guard and police work.`,
    temperament: `Dobermans are known for being loyal, alert, and highly trainable, often forming close bonds with their families. Many remain watchful and devoted companions well into their senior years.`,
    seniorPatterns: `Heart health is one of the most widely discussed topics for Dobermans as they age, and it's an area many vets pay particular attention to during senior wellness visits for this breed specifically. Staying consistent with regular vet checkups alongside your own tracking is commonly recommended.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '10–13 years' },
    exercise: `Dobermans are an athletic, working breed that generally needs real daily exercise along with mental stimulation — training and structured activity tend to suit this breed particularly well. Many owners find that a Doberman getting enough physical and mental engagement is noticeably more settled at home.`
  },
  'boxer': {
    displayName: 'Boxer',
    typicalWeight: '50–80 lb',
    history: `Boxers were developed in Germany in the late 1800s, descended from bull-baiting breeds and later refined into versatile working dogs used for guarding, police work, and companionship.`,
    temperament: `Boxers are known for being playful, energetic, and loyal, often maintaining a puppyish enthusiasm well into adulthood. Many stay engaged and affectionate through their senior years, even as activity levels naturally decrease.`,
    seniorPatterns: `Heart health is a commonly discussed topic among Boxer owners as the breed ages, and it's an area many vets pay particular attention to during senior wellness visits. Joint health and gradual changes in exercise tolerance are also frequently discussed. Regular vet checkups alongside your own tracking can help catch changes early.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '10–12 years' },
    exercise: `Boxers tend to stay playful and high-energy well into adulthood, and most do best with real daily exercise and interactive play rather than a short walk alone. Owners often find that this breed's enthusiasm for play is one of its most enduring traits, even as the pace naturally slows with age.`
  },
  'bernese mountain dog': {
    displayName: 'Bernese Mountain Dog',
    pronunciation: 'ber-NEEZ Mountain Dog',
    typicalWeight: '70–115 lb',
    history: `Bernese Mountain Dogs originated in the Swiss Alps, bred by farmers as versatile working dogs for driving cattle, pulling carts, and guarding property. Their name comes from the canton of Bern.`,
    temperament: `Berners are known for being gentle, calm, and deeply affectionate with their families. Many remain sweet, easygoing companions well into their senior years, often preferring to be near their people over anything else.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Berner owners given the breed's size, and many owners find that this breed tends to show its age a bit earlier than some other large breeds. Regular, gentle exercise and weight management are commonly discussed with vets as ways to support comfort in the senior years.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — long double coat, regular brushing needed, heavy seasonal shedding', averageLifespan: '7–10 years' },
    exercise: `Berners generally do well with moderate exercise — hiking or pulling-style activities echo their working heritage, though this isn't a breed that needs to run for hours. Given their heavy coat, many owners find their Berner is more comfortable exercising in cooler weather and prefers to take it easy when it's warm out.`
  },
  'great dane': {
    displayName: 'Great Dane',
    typicalWeight: '110–175 lb',
    history: `Great Danes descend from large mastiff-type dogs used in Germany for boar hunting and estate guarding, later refined into the gentle giant companion breed known today.`,
    temperament: `Great Danes are known for being gentle, affectionate, and surprisingly laid-back for their size — often described as "gentle giants." Many remain calm, dignified companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Great Dane owners as the breed ages. Owners often work closely with their vets on weight management and mobility support, since extra strain on joints and the heart can be more noticeable in giant breeds.`,
    atAGlance: { energyLevel: 'Low-Moderate', grooming: 'Very low-maintenance, short coat with minimal shedding', averageLifespan: '7–10 years' },
    exercise: `Despite their imposing size, Great Danes typically need only moderate exercise — a couple of relaxed walks a day is often enough, and many are just as happy stretched out on the couch. Because giant breeds grow so quickly early on, many owners are especially mindful of avoiding high-impact activity like jumping or long runs while a Dane is still young, to go easy on developing joints. As adults, steady, moderate movement tends to suit the breed better than anything high-intensity.`
  },
  'siberian husky': {
    displayName: 'Siberian Husky',
    typicalWeight: '35–60 lb',
    history: `Siberian Huskies were developed by the Chukchi people of northeastern Siberia as endurance sled dogs, bred to pull light loads over long distances in extreme cold. They were brought to Alaska in the early 1900s and gained wider popularity through sled-racing.`,
    temperament: `Huskies are known for being energetic, independent, and highly social with people and other dogs. Many stay spirited and vocal well into their senior years, even as their exercise needs gradually decrease.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Huskies as they age, and joint health is a frequent topic for active breeds generally. Owners often find that adjusting (rather than eliminating) exercise routines helps senior Huskies stay comfortable and engaged.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Thick double coat, sheds heavily twice a year — regular brushing needed', averageLifespan: '12–14 years' },
    exercise: `Huskies were bred to run, and it shows — most need real, vigorous daily exercise, not just a walk around the block, along with mental stimulation to stay content. Under-exercised Huskies are well known for being escape artists, so secure fencing and reliable leashing matter more for this breed than most. Owners often find that structured activities — running, hiking, or dedicated play sessions — work better than expecting a Husky to self-regulate in a yard alone.`
  },
  'vizsla': {
    displayName: 'Vizsla',
    pronunciation: 'VEEZH-lah',
    typicalWeight: '45–65 lb',
    history: `Vizslas originated in Hungary, developed by nobility as versatile hunting dogs skilled at pointing and retrieving. Their short, sleek coat and lean build reflect their history as an all-purpose field dog.`,
    temperament: `Vizslas are known for being affectionate, energetic, and closely bonded to their people — often nicknamed "velcro dogs" for how closely they like to stay by their owner's side. Many remain eager and attentive well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Vizsla owners as the breed ages, given their athletic build earlier in life. Skin health is also sometimes discussed for the breed generally. Owners often find that keeping a senior Vizsla mentally and physically engaged (at a gentler pace) supports overall wellbeing.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance short coat', averageLifespan: '12–14 years' },
    exercise: `Vizslas were bred as all-day field dogs, and most genuinely need extensive daily exercise — this is one of the higher-energy breeds here. Because they're so closely bonded to their people, many do best exercising alongside their owner rather than left to entertain themselves, and can become anxious or restless without enough activity.`
  },
  'mastiff': {
    displayName: 'Mastiff',
    typicalWeight: '120–230 lb',
    history: `Mastiffs are among the oldest recognized dog breeds, with ancestry tracing back thousands of years to large guardian dogs used across the ancient world. The modern English Mastiff was refined in Britain and valued for its size and protective nature.`,
    temperament: `Mastiffs are known for being calm, dignified, and gentle with their families despite their imposing size. Many remain low-key, affectionate companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Mastiff owners as the breed ages. Owners often work closely with their vets on weight management specifically, since even modest excess weight adds significant strain to joints in giant breeds.`,
    atAGlance: { energyLevel: 'Low', grooming: 'Low-maintenance short coat, though some drooling is common', averageLifespan: '6–10 years' },
    exercise: `Despite their massive size, Mastiffs typically need only modest exercise — a couple of short, easy walks a day is often plenty. Given how quickly giant breeds grow early on, many owners are especially careful to avoid high-impact activity like jumping while a Mastiff is still young. Heat can also be a real consideration for this breed, given their size and coat.`
  },
  'rhodesian ridgeback': {
    displayName: 'Rhodesian Ridgeback',
    typicalWeight: '70–85 lb',
    history: `Rhodesian Ridgebacks were developed in southern Africa, bred by combining European breeds with a native ridged-back hunting dog kept by the Khoikhoi people. They were historically used to track large game, including lions, though not to attack them.`,
    temperament: `Ridgebacks are known for being loyal, independent, and dignified, often forming a close bond with one family. Many stay alert and steady well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Ridgeback owners as the breed ages, given their athletic build earlier in life. Owners often notice gradual changes in activity tolerance before other signs appear. Regular vet checkups alongside your own tracking are a good way to stay ahead of changes.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '10–12 years' },
    exercise: `Ridgebacks were bred for endurance, and most do best with real daily exercise — a short walk alone typically isn't enough for this breed. Many owners find that consistent, vigorous activity suits this independent breed well, and that a well-exercised Ridgeback tends to be a calmer, easier companion at home.`
  },
  'newfoundland': {
    displayName: 'Newfoundland',
    pronunciation: 'NEW-fund-lund (stress on the first syllable, not "found")',
    typicalWeight: '100–150 lb',
    history: `Newfoundlands originated on the island of Newfoundland, Canada, developed as working dogs for fishermen — known for strength, swimming ability, and a talent for water rescue.`,
    temperament: `Newfoundlands are known for being gentle, patient, and famously good-natured, often called "gentle giants." Many remain calm, sweet companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Newfoundland owners as the breed ages. Owners often work with their vets on weight management and moderate, joint-friendly exercise (like swimming) to support comfort in the senior years.`,
    atAGlance: { energyLevel: 'Low-to-Moderate', grooming: 'High — heavy double coat, regular brushing, heavy seasonal shedding', averageLifespan: '8–10 years' },
    exercise: `Newfoundlands generally need only moderate exercise, and given their history as water-rescue dogs, many genuinely love to swim — it's often an easier option on their joints than running. Their heavy coat means many owners find this breed more comfortable exercising in cooler weather and prefer to take it slow when it's hot.`
  },

  // ===== Smaller breeds =====
  'french bulldog': {
    displayName: 'French Bulldog',
    typicalWeight: '16–28 lb',
    history: `French Bulldogs descend from small English Bulldogs brought to France by lace workers in the 1800s, where they were crossed with local breeds and refined into the compact companion dog known today. They were recognized by the AKC in 1898.`,
    temperament: `Frenchies are known for being affectionate, easygoing, and adaptable — traits that have made them especially popular with owners in cities and smaller living spaces. Many remain playful and people-focused well into their senior years.`,
    seniorPatterns: `Breathing and airway comfort is one of the most commonly discussed topics for French Bulldogs throughout life, given the breed's short-nosed (brachycephalic) build, and it's especially worth watching in warm weather or during activity. Spinal and joint health are also frequently discussed topics for the breed. Weight management can meaningfully affect comfort and breathing ease.`,
    atAGlance: { energyLevel: 'Low-Moderate', grooming: 'Low-shedding coat, but facial/skin folds need regular cleaning', averageLifespan: '10–12 years' },
    exercise: `Frenchies generally don't need much exercise compared to many breeds — a couple of short walks and some play time is often plenty. Because of their short-nosed build, most do best avoiding heavy exertion or extended time in heat at any age, with owners commonly favoring cooler parts of the day and shorter, calmer sessions over long or vigorous ones. This isn't unique to older dogs — it's a breed trait worth planning around from the start.`
  },
  'dachshund': {
    displayName: 'Dachshund',
    pronunciation: 'DAHKS-hoont (not "dash-hound")',
    typicalWeight: '11–32 lb',
    history: `Dachshunds were developed in Germany, originally bred to hunt badgers — their name literally translates to "badger dog." Their long, low build was specifically suited to tunneling into burrows after game.`,
    temperament: `Dachshunds are known for being spirited, loyal, and sometimes stubborn — traits that likely served them well as independent hunters. Many stay alert and vocal well into their senior years.`,
    seniorPatterns: `Back and spinal health is one of the most commonly discussed topics among Dachshund owners at any age, given the breed's elongated body shape, and it often becomes a bigger focus as dogs age. Owners commonly watch for reluctance to jump, changes in gait, or sensitivity around the back. Weight management is also frequently discussed, since extra weight adds strain to the spine.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Varies by coat type (smooth, long, or wire) — generally low-to-moderate', averageLifespan: '12–16 years' },
    exercise: `Dachshunds do well with regular, moderate exercise like walks and play, but given their elongated build, many owners are mindful about avoiding activities that involve a lot of jumping or repeated stair use, to go easy on the back. This is a trait worth planning around at any age, not just as dogs get older.`
  },
  'cavalier king charles spaniel': {
    displayName: 'Cavalier King Charles Spaniel',
    typicalWeight: '13–18 lb',
    history: `Cavalier King Charles Spaniels descend from small companion spaniels favored in English royal courts for centuries, later refined in the early 1900s into the breed recognized today, named after King Charles II.`,
    temperament: `Cavaliers are known for being gentle, affectionate, and eager to be close to their people — bred specifically as companions. Many remain sweet-natured and devoted well into their senior years.`,
    seniorPatterns: `Heart health is one of the most widely discussed topics for Cavaliers as they age, and it's an area many vets pay close attention to during regular senior wellness visits for this breed specifically. Staying consistent with vet checkups alongside your own tracking is commonly recommended for Cavalier owners.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Moderate — silky coat needs regular brushing', averageLifespan: '9–14 years' },
    exercise: `Cavaliers generally do well with moderate daily exercise — a couple of walks and some play is often enough for this companion breed. Many stay eager to be active with their people well into their senior years, and owners often find gentle, consistent activity suits this breed better than anything strenuous.`
  },
  'yorkshire terrier': {
    displayName: 'Yorkshire Terrier',
    typicalWeight: '4–7 lb',
    history: `Yorkshire Terriers originated in 19th-century England, bred by working-class weavers to catch rats in textile mills. Their small size and tenacity made them effective at the job before they became popular companion dogs.`,
    temperament: `Yorkies are known for being confident, energetic, and affectionate with their families, often carrying a "big dog" attitude despite their small size. Many stay lively and attentive well into their senior years.`,
    seniorPatterns: `Like many small breeds, dental health is a commonly discussed topic for Yorkies throughout their lives. Owners also frequently discuss joint and knee health as dogs age. Because of their small size, subtle changes in energy or mobility are often easier for owners to notice early.`,
    atAGlance: { energyLevel: 'Moderate-to-High', grooming: 'High — silky coat needs regular brushing and trims (lower-maintenance if kept in a short clip)', averageLifespan: '11–15 years' },
    exercise: `Yorkies often have more energy than their small size suggests, and many enjoy short walks and active play sessions. Because they're small, owners sometimes find it easier to give this breed adequate exercise indoors or in a yard than some larger, more space-demanding breeds require.`
  },
  'pembroke welsh corgi': {
    displayName: 'Pembroke Welsh Corgi',
    typicalWeight: '22–30 lb',
    history: `Pembroke Welsh Corgis originated in Wales, bred as herding dogs for cattle despite their small size — their low build allowed them to nip at heels while avoiding kicks. They later became widely known as a favorite breed of Queen Elizabeth II.`,
    temperament: `Corgis are known for being smart, energetic, and confident, with a strong herding instinct that often shows up in play. Many stay lively and food-motivated well into their senior years.`,
    seniorPatterns: `Back and spinal health is a commonly discussed topic for Corgis given their long body and short legs, similar to other elongated breeds. Weight management is especially frequently discussed for this breed, since extra weight adds real strain to both the spine and joints.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate-to-high — double coat sheds heavily', averageLifespan: '12–14 years' },
    exercise: `Corgis were bred to herd all day, and many have surprisingly high energy for their size — regular walks and active play matter for this breed. Given their long back and short legs, owners are commonly mindful about avoiding activities involving a lot of jumping, to go easy on the spine.`
  },
  'miniature schnauzer': {
    displayName: 'Miniature Schnauzer',
    typicalWeight: '11–20 lb',
    history: `Miniature Schnauzers were developed in Germany by breeding down the Standard Schnauzer, originally used as farm dogs skilled at ratting and general guarding duties.`,
    temperament: `Miniature Schnauzers are known for being alert, friendly, and spirited, often making excellent watchdogs despite their small size. Many stay energetic and engaged well into their senior years.`,
    seniorPatterns: `Dental health and eye health are commonly discussed topics for Miniature Schnauzers as they age. Weight management is also frequently discussed, since the breed can be prone to gaining weight if activity decreases. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate-to-High', grooming: 'High — wiry coat needs regular trimming/stripping', averageLifespan: '12–14 years' },
    exercise: `Miniature Schnauzers generally do well with regular walks and active play, and many stay energetic and engaged well into their senior years. This is a breed that benefits from consistent activity, since owners often find that a Schnauzer's weight can creep up if exercise tapers off.`
  },
  'pomeranian': {
    displayName: 'Pomeranian',
    typicalWeight: '3–7 lb',
    history: `Pomeranians descend from larger sled-dog-type breeds in the Pomerania region of Central Europe, gradually bred down in size over generations into the small companion dog known today. They became especially popular after Queen Victoria took an interest in the breed in the late 1800s.`,
    temperament: `Pomeranians are known for being lively, alert, and confident, often described as having a big personality in a small package. Many stay spirited and vocal well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Pomeranians throughout life, as it is for many small breeds. Tracheal and joint health are also frequently discussed topics as the breed ages. Because Pomeranians are small, owners often find it easier to spot subtle day-to-day changes than with larger dogs.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — thick double coat needs regular brushing', averageLifespan: '12–16 years' },
    exercise: `Pomeranians typically do well with short walks and indoor play — this isn't a breed that needs extensive exercise, and many are just as happy with a few active bursts throughout the day. Given the breed's small size, owners commonly favor gentler play over anything involving a lot of jumping.`
  },
  'shih tzu': {
    displayName: 'Shih Tzu',
    pronunciation: 'SHEED-zoo',
    typicalWeight: '9–16 lb',
    history: `Shih Tzus originated in China, believed to be bred from Tibetan breeds and favored as companion dogs in Chinese royal courts for centuries before becoming popular worldwide in the 20th century.`,
    temperament: `Shih Tzus are known for being affectionate, outgoing, and people-oriented — bred specifically to be companions rather than working dogs. Many stay sweet-natured and attentive well into their senior years.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Shih Tzus given their prominent eye shape, and dental health is a frequent topic for small breeds generally. Breathing comfort is also sometimes discussed given the breed's shorter muzzle. Regular grooming and vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Low-to-Moderate', grooming: 'Very high — long coat needs daily brushing or regular short trims', averageLifespan: '10–16 years' },
    exercise: `Shih Tzus generally do well with modest exercise — short walks and some play are usually enough for this companion breed. Given their shorter muzzle, many owners are mindful about avoiding strenuous activity or extended time in heat, favoring calmer, cooler outings instead.`
  },
  'boston terrier': {
    displayName: 'Boston Terrier',
    typicalWeight: '10–25 lb',
    history: `Boston Terriers were developed in the United States in the late 1800s, one of the first breeds developed specifically in America. They're sometimes called "the American Gentleman" for their tuxedo-like coat pattern.`,
    temperament: `Boston Terriers are known for being friendly, lively, and adaptable, often described as having a comedic personality. Many stay playful and affectionate well into their senior years.`,
    seniorPatterns: `Breathing comfort is a commonly discussed topic for Boston Terriers given their short-nosed (brachycephalic) build, and eye health is also a frequent topic for the breed. Weight management can meaningfully support breathing comfort as the breed ages.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Low-maintenance short coat', averageLifespan: '11–13 years' },
    exercise: `Boston Terriers generally do well with regular, moderate exercise — daily walks and play sessions suit this playful breed well. Given their shorter muzzle, many owners favor cooler parts of the day and avoid especially strenuous or prolonged activity, particularly in warm weather.`
  },
  'chihuahua': {
    displayName: 'Chihuahua',
    pronunciation: 'chih-WAH-wah',
    typicalWeight: '2–6 lb',
    history: `Chihuahuas take their name from the Mexican state of Chihuahua, where the breed was discovered by American travelers in the 1850s. Their exact ancestral origins are debated, but they're widely recognized as one of the oldest breeds in the Americas.`,
    temperament: `Chihuahuas are known for big personalities in small bodies — often alert, confident, and deeply bonded to their owners. Many remain feisty and engaged throughout their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Chihuahuas throughout life, given their small jaw size, and often becomes more prominent with age. Knee (patella) health is another frequently discussed topic for small breeds generally. Because Chihuahuas are small, owners sometimes find it easier to notice subtle changes in movement or appetite than with larger dogs.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Low-maintenance (smooth coat) to moderate (long coat)', averageLifespan: '14–16 years' },
    exercise: `Chihuahuas generally do well with short walks and indoor play — this breed doesn't need extensive exercise given its size, though many stay lively and enjoy staying active. Because they're so small, owners are commonly careful about jumping from furniture or rough play, given how delicate their frame can be.`
  },
  'havanese': {
    displayName: 'Havanese',
    pronunciation: 'hav-uh-NEEZ',
    typicalWeight: '7–13 lb',
    history: `Havanese dogs originated in Cuba, descended from small Mediterranean companion breeds brought over by Spanish settlers, and are the only dog breed native to the island.`,
    temperament: `Havanese are known for being friendly, playful, and highly people-oriented, often thriving on close companionship. Many remain sociable and attentive well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Havanese throughout life, as it is for many small breeds. Eye health and joint health are also sometimes discussed as the breed ages. Owners often find this breed adapts well to a gentler activity pace as it gets older.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — long coat needs regular brushing (or a shorter clip for easier upkeep)', averageLifespan: '14–16 years' },
    exercise: `Havanese generally do well with moderate exercise — regular walks and play sessions suit this social, adaptable breed well. Many remain eager for activity with their people well into their senior years, and owners often find this breed adjusts comfortably to a gentler pace over time.`
  },
  'maltese': {
    displayName: 'Maltese',
    typicalWeight: '4–7 lb',
    history: `Maltese dogs are among the oldest toy breeds, with a history tracing back thousands of years around the Mediterranean, prized as companion dogs by ancient nobility.`,
    temperament: `Maltese are known for being gentle, affectionate, and lively, often forming close bonds with their people. Many stay sweet-natured and alert well into their senior years.`,
    seniorPatterns: `Dental health is one of the most commonly discussed topics for Maltese throughout life, given their small jaw size. Eye health is also a frequently discussed topic for the breed. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Low-to-Moderate', grooming: 'High — long silky coat needs daily brushing (or regular short trims)', averageLifespan: '12–15 years' },
    exercise: `Maltese generally do well with short walks and gentle play — this companion breed doesn't need extensive exercise given its size. Many stay lively and alert well into their senior years with a modest, consistent routine rather than anything strenuous.`
  },
  'pug': {
    displayName: 'Pug',
    typicalWeight: '14–18 lb',
    history: `Pugs originated in China, bred as companion dogs for Chinese royalty, and were later brought to Europe by Dutch traders in the 1500s, where they became popular in royal courts.`,
    temperament: `Pugs are known for being affectionate, playful, and easygoing, often described as having a charming, sociable personality. Many stay warm and people-focused well into their senior years.`,
    seniorPatterns: `Breathing and airway comfort is one of the most commonly discussed topics for Pugs throughout life, given the breed's short-nosed (brachycephalic) build. Weight management is especially frequently discussed for this breed, since extra weight can meaningfully affect breathing comfort and joint health. Skin-fold care is also a common topic.`,
    atAGlance: { energyLevel: 'Low-to-Moderate', grooming: 'Low-maintenance coat, but sheds noticeably', averageLifespan: '12–15 years' },
    exercise: `Pugs generally do well with short, gentle walks — this isn't a breed built for vigorous or prolonged exercise. Given their short-nosed build, most do best avoiding heat and heavy exertion at any age, with owners commonly favoring cooler, calmer outings over anything strenuous.`
  },
  'papillon': {
    displayName: 'Papillon',
    pronunciation: 'PAP-ee-yawn',
    typicalWeight: '5–10 lb',
    history: `Papillons take their name from the French word for "butterfly," referencing their distinctive fringed ears. The breed has a long history as a companion dog in European royal courts, dating back centuries.`,
    temperament: `Papillons are known for being alert, friendly, and surprisingly athletic for their size. Many remain lively and mentally sharp well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Papillons throughout life, as it is for many small breeds. Knee (patella) health is also a frequently discussed topic. Because Papillons are small and often quite active, owners sometimes find it easier to notice subtle changes early.`,
    atAGlance: { energyLevel: 'Moderate-to-High', grooming: 'Moderate — silky coat needs regular brushing, no trimming required', averageLifespan: '14–16 years' },
    exercise: `Papillons are often more athletic and energetic than their small size suggests, and many enjoy regular walks and active play. Owners commonly find this breed does well with both physical exercise and mental stimulation, like training or puzzle toys, given how quick and engaged the breed tends to be.`
  },
  'bichon frise': {
    displayName: 'Bichon Frise',
    pronunciation: 'BEE-shon free-ZAY',
    typicalWeight: '12–18 lb',
    history: `Bichon Frises descend from small Mediterranean water dogs, with a history tracing through Spain, France, and Italy as beloved companion dogs in European courts for centuries.`,
    temperament: `Bichons are known for being cheerful, affectionate, and playful, often described as having a naturally happy disposition. Many stay sociable and lively well into their senior years.`,
    seniorPatterns: `Skin and coat health are commonly discussed topics for Bichons throughout life, along with dental health, as is common for many small breeds. Eye health is also sometimes discussed as the breed ages. Regular grooming and vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — curly coat needs regular brushing and trims', averageLifespan: '14–15 years' },
    exercise: `Bichons generally do well with regular walks and playful activity — a happy, moderate routine suits this cheerful breed well. Many stay sociable and eager to be involved well into their senior years, and owners often find consistent, gentle exercise keeps this breed at a healthy, comfortable weight.`
  },

  'standard poodle': {
    displayName: 'Standard Poodle',
    typicalWeight: '45–70 lb',
    history: `Poodles originated in Germany as water retrievers (the name derives from the German "pudel," to splash in water), though the breed was refined and popularized in France, where it became the national dog. The distinctive clip originally served a practical purpose — keeping joints warm in cold water while reducing drag elsewhere.`,
    temperament: `Standard Poodles are known for being highly intelligent, athletic, and eager to please — traits that have made them successful in everything from hunting to obedience competition. Many remain alert and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic for Standard Poodles as they age, given their athletic build earlier in life. Owners often notice gradual changes in stamina before other signs appear. Regular vet checkups alongside your own tracking are a good way to stay ahead of changes.`,
    atAGlance: { energyLevel: 'High', grooming: 'Very high — curly, continuously-growing coat needs professional grooming every 4–6 weeks', averageLifespan: '12–15 years' },
    exercise: `Standard Poodles were bred as working retrievers, and most need real daily exercise along with mental stimulation — this is a genuinely athletic, intelligent breed, not just a show dog. Many enjoy swimming, which echoes their original purpose and is easy on the joints as they age.`
  },

  'miniature poodle': {
    displayName: 'Miniature Poodle',
    typicalWeight: '10–15 lb',
    history: `Miniature Poodles were bred down from the Standard Poodle in France, prized for the same intelligence and trainability in a smaller companion size.`,
    temperament: `Miniature Poodles are known for being clever, lively, and affectionate, often just as trainable as their larger counterparts. Many stay playful and alert well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Miniature Poodles, as it is for many smaller breeds. Joint (patella) health is also sometimes discussed as the breed ages. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'Very high — curly coat needs professional grooming every 4–6 weeks', averageLifespan: '12–15 years' },
    exercise: `Miniature Poodles generally do well with regular walks and active play — this breed retains real intelligence and energy in a smaller frame, and many enjoy training and puzzle-style activities as much as physical exercise.`
  },

  'toy poodle': {
    displayName: 'Toy Poodle',
    typicalWeight: '4–6 lb',
    history: `Toy Poodles are the smallest of the three Poodle varieties, bred down further in France and later the U.S. as a companion-sized version of the same intelligent breed.`,
    temperament: `Toy Poodles are known for being alert, affectionate, and quick to learn, often carrying the same sharp intelligence as their larger relatives in a much smaller body. Many stay lively and attentive well into their senior years.`,
    seniorPatterns: `Dental health is one of the most commonly discussed topics for Toy Poodles, given their small jaw size. Joint (patella) health is also frequently discussed for the breed. Because Toy Poodles are so small, owners often find it easier to notice subtle changes early.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Very high — curly coat needs professional grooming every 4–6 weeks', averageLifespan: '14–18 years' },
    exercise: `Toy Poodles generally do well with short walks and indoor play — this breed doesn't need extensive exercise given its size, though many stay eager and enjoy training. Because they're so small, owners are commonly careful about jumping from furniture or rough handling.`
  },

  'beagle': {
    displayName: 'Beagle',
    typicalWeight: '20–30 lb',
    history: `Beagles were developed in England as scent hounds, bred to hunt in packs by following ground scent, particularly for hunting hare. Their exact ancestry is debated, but small hound-type dogs have existed in Britain for centuries.`,
    temperament: `Beagles are known for being friendly, curious, and famously food-motivated, with a strong nose that often leads their attention. Many stay playful and social well into their senior years.`,
    seniorPatterns: `Weight management is one of the most commonly discussed topics for Beagle owners, given the breed's food drive and tendency to gain weight if activity decreases. Joint health and ear health (given their long, low-hanging ears) are also frequently discussed. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '12–15 years' },
    exercise: `Beagles were bred to follow a scent for miles, and most do best with real daily exercise — walks alone often aren't enough to satisfy this breed's nose-driven energy. Because Beagles are so food-motivated, owners commonly pair exercise with weight management, since it's easy for this breed to gain weight if activity tapers off.`
  },

  'bulldog': {
    displayName: 'Bulldog',
    typicalWeight: '40–55 lb',
    history: `Bulldogs originated in England, originally bred for bull-baiting before the practice was outlawed, after which the breed was refined into the gentler, companion-focused dog known today.`,
    temperament: `Bulldogs are known for being calm, affectionate, and dependable, often described as having a dignified, easygoing nature. Many remain sweet, low-key companions well into their senior years.`,
    seniorPatterns: `Breathing and airway comfort is one of the most commonly discussed topics for Bulldogs throughout life, given the breed's short-nosed (brachycephalic) build, and it's especially worth watching in warm weather or during activity. Joint health and skin-fold care are also frequently discussed topics for the breed. Weight management can meaningfully affect comfort and breathing ease.`,
    atAGlance: { energyLevel: 'Low', grooming: 'Low-maintenance coat, but skin folds need regular cleaning', averageLifespan: '8–10 years' },
    exercise: `Bulldogs generally need only modest exercise — short walks are usually plenty, and this isn't a breed built for vigorous or prolonged activity. Because of their short-nosed build, most do best avoiding heat and heavy exertion at any age, with owners commonly favoring cooler, calmer outings over anything strenuous.`
  },

  'australian shepherd': {
    displayName: 'Australian Shepherd',
    typicalWeight: '40–65 lb',
    history: `Despite the name, Australian Shepherds were largely developed in the United States, bred by ranchers (some with Basque shepherd ancestry passing through Australia) as versatile herding dogs for livestock work.`,
    temperament: `Aussies are known for being intelligent, energetic, and highly trainable, often forming close working partnerships with their people. Many stay mentally sharp and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Aussie owners as the breed ages, given their athletic build and activity level earlier in life. Eye health is also sometimes discussed for the breed. Owners often find that keeping a senior Aussie mentally engaged, even at a gentler pace, supports overall wellbeing.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Moderate-high — double coat sheds seasonally', averageLifespan: '12–15 years' },
    exercise: `Aussies were bred to herd all day, and most need substantial daily exercise along with real mental engagement — this is one of the higher-energy breeds here, and a plain walk often isn't enough. Owners commonly find that training, herding-style games, or a structured job keep this breed content and out of trouble.`
  },

  'border collie': {
    displayName: 'Border Collie',
    typicalWeight: '30–45 lb',
    history: `Border Collies originated in the border region between England and Scotland, bred specifically for herding sheep and widely regarded as one of the most trainable working breeds ever developed.`,
    temperament: `Border Collies are known for exceptional intelligence, focus, and drive, often needing a "job" to feel fulfilled. Many stay mentally sharp and eager to work well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Border Collie owners as the breed ages, given their athletic build and activity level earlier in life. Eye health is also sometimes discussed. Owners often find that adjusting (rather than eliminating) mental and physical activity helps senior Border Collies stay comfortable and engaged.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Moderate — double coat needs regular brushing', averageLifespan: '12–15 years' },
    exercise: `Border Collies are widely considered one of the most energetic and driven breeds, and most genuinely need extensive daily exercise plus real mental work — herding, agility, or advanced training tend to suit this breed far better than a simple walk. Under-stimulated Border Collies are known for developing restless or repetitive behaviors, making consistent activity especially important.`
  },

  'english springer spaniel': {
    displayName: 'English Springer Spaniel',
    typicalWeight: '40–50 lb',
    history: `English Springer Spaniels were developed in England as versatile hunting dogs, bred to "spring" game birds into the air for hunters, and are among the oldest sporting spaniel breeds.`,
    temperament: `Springers are known for being friendly, eager, and energetic, often excelling in both the field and as family companions. Many stay playful and engaged well into their senior years.`,
    seniorPatterns: `Ear health is a commonly discussed topic for Springers given their long, low-hanging ears, and joint health is a frequent topic for active sporting breeds generally. Owners often find that adjusting exercise routines helps senior Springers stay comfortable.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate — regular brushing needed, ears need routine cleaning', averageLifespan: '12–14 years' },
    exercise: `Springers were bred for active fieldwork, and most do best with real daily exercise — a short walk alone typically isn't enough for this breed. Many enjoy retrieving games and swimming, and owners often find a well-exercised Springer is a calmer, easier companion at home.`
  },

  'miniature american shepherd': {
    displayName: 'Miniature American Shepherd',
    typicalWeight: '20–40 lb',
    history: `Miniature American Shepherds were developed in the United States by breeding down smaller Australian Shepherds, aiming to preserve the breed's herding instincts and intelligence in a more compact size.`,
    temperament: `Mini Aussies are known for being intelligent, energetic, and eager to please, sharing much of the standard Australian Shepherd's drive in a smaller frame. Many stay mentally engaged well into their senior years.`,
    seniorPatterns: `Joint health and eye health are commonly discussed topics for Mini Aussies as they age, similar to their larger counterparts. Owners often find that keeping this breed mentally engaged, even at a gentler pace, supports overall wellbeing in the senior years.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate — double coat sheds seasonally', averageLifespan: '13–15 years' },
    exercise: `Mini Aussies retain much of the standard Australian Shepherd's drive, and most need real daily exercise along with mental stimulation — training and interactive play tend to suit this breed well. Owners often find that this breed's smaller size doesn't mean smaller energy needs.`
  },

  'shetland sheepdog': {
    displayName: 'Shetland Sheepdog',
    typicalWeight: '15–25 lb',
    history: `Shetland Sheepdogs originated in Scotland's Shetland Islands, developed to herd sheep and ponies in a harsh climate, and are often described as a smaller relative of the Rough Collie.`,
    temperament: `Shelties are known for being intelligent, loyal, and eager to please, often excelling in obedience and agility. Many stay alert and engaged well into their senior years.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Shelties as they age, and joint health is a frequent topic for active herding breeds generally. Owners often find that adjusting (rather than eliminating) exercise and mental stimulation helps senior Shelties stay comfortable.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — long double coat needs regular brushing, heavy seasonal shedding', averageLifespan: '12–14 years' },
    exercise: `Shelties were bred to herd, and most do well with regular exercise and mental engagement — training and agility-style activities suit this intelligent breed particularly well. Many stay eager to work and please their people well into their senior years, just at a gentler pace.`
  },

  'brittany': {
    displayName: 'Brittany',
    typicalWeight: '30–40 lb',
    history: `Brittanys originated in the Brittany region of France, developed as versatile bird-hunting dogs valued for their pointing ability and stamina in the field.`,
    temperament: `Brittanys are known for being energetic, eager, and affectionate, often described as having a happy, willing disposition. Many remain active and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Brittany owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance coat, moderate shedding', averageLifespan: '12–14 years' },
    exercise: `Brittanys were bred for all-day fieldwork, and most need substantial daily exercise to stay content — this is a genuinely high-energy breed, not just an active one. Owners commonly find that a well-exercised Brittany is noticeably calmer and easier to live with at home.`
  },

  'belgian malinois': {
    displayName: 'Belgian Malinois',
    pronunciation: 'MAL-in-wah',
    typicalWeight: '40–80 lb',
    history: `Belgian Malinois were developed in Belgium as herding dogs and are one of four Belgian sheepdog varieties, later becoming widely used in police, military, and protection work for their drive and trainability.`,
    temperament: `Malinois are known for being highly intelligent, driven, and protective, often needing an experienced owner who can channel their energy productively. Many stay alert and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic for Malinois as they age, given their athletic build and activity level earlier in life. Owners often find that structured mental work remains important even as physical exercise needs taper off with age.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance short coat, sheds seasonally', averageLifespan: '12–14 years' },
    exercise: `Malinois are widely used as working dogs for a reason — most need extensive daily exercise and real mental work, and this breed can become genuinely difficult to live with if under-stimulated. Structured training or a job tends to suit this breed far better than casual walks alone.`
  },

  'cocker spaniel': {
    displayName: 'Cocker Spaniel',
    typicalWeight: '20–30 lb',
    history: `Cocker Spaniels were developed in England and later refined in America, originally bred to hunt woodcock (hence the name), and became one of the most popular companion breeds of the 20th century.`,
    temperament: `Cocker Spaniels are known for being gentle, affectionate, and eager to please, often described as having a sweet, sensitive disposition. Many remain sociable and attentive well into their senior years.`,
    seniorPatterns: `Ear health is one of the most commonly discussed topics for Cocker Spaniels given their long, low-hanging ears, and eye health is also frequently discussed. Weight management is another common topic, since extra weight can affect joint comfort as the breed ages.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — silky coat needs regular brushing and trims, ears need routine cleaning', averageLifespan: '12–15 years' },
    exercise: `Cocker Spaniels generally do well with regular walks and play sessions — this breed doesn't need extreme exercise, but does benefit from consistent daily activity. Owners often find that keeping this breed active helps with weight management, since Cockers can gain weight if exercise tapers off.`
  },

  'basset hound': {
    displayName: 'Basset Hound',
    typicalWeight: '40–65 lb',
    history: `Basset Hounds originated in France, bred as scent hounds with a low build specifically suited to tracking ground scent at a pace hunters on foot could follow.`,
    temperament: `Basset Hounds are known for being easygoing, friendly, and famously food-motivated, often moving at their own unhurried pace. Many remain sociable and calm well into their senior years.`,
    seniorPatterns: `Back and joint health are commonly discussed topics among Basset Hound owners, given the breed's long body and short legs. Ear health is also frequently discussed given their long ears. Weight management is especially important for this breed, since extra weight adds real strain to both the spine and joints.`,
    atAGlance: { energyLevel: 'Low-Moderate', grooming: 'Low-maintenance short coat, though some drooling and shedding is common', averageLifespan: '12–13 years' },
    exercise: `Basset Hounds generally do well with regular, moderate walks — this isn't a breed built for vigorous or prolonged exercise. Given their elongated build, many owners are mindful about avoiding activities involving a lot of jumping or stairs, to go easy on the back, a consideration worth planning around at any age.`
  },

  'english cocker spaniel': {
    displayName: 'English Cocker Spaniel',
    typicalWeight: '26–34 lb',
    history: `English Cocker Spaniels share ancestry with the American Cocker Spaniel but were bred and standardized separately in England, developed as versatile hunting dogs for flushing game.`,
    temperament: `English Cockers are known for being affectionate, energetic, and eager to please, often slightly more athletic and outgoing than their American cousins. Many stay active and social well into their senior years.`,
    seniorPatterns: `Ear health is a commonly discussed topic for English Cockers given their long ears, and eye health is also frequently discussed. Weight management is another common topic, since extra weight can affect joint comfort as the breed ages.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — silky coat needs regular brushing and trims, ears need routine cleaning', averageLifespan: '12–14 years' },
    exercise: `English Cockers were bred for active fieldwork and tend to have real exercise needs — regular walks and play, along with opportunities to use their nose, suit this breed well. Owners often find this breed benefits from more activity than its American Cocker relative.`
  },

  'collie': {
    displayName: 'Collie',
    typicalWeight: '50–75 lb',
    history: `Collies originated in Scotland as herding dogs and became widely popular in the U.S. and beyond after being featured as "Lassie" in film and television.`,
    temperament: `Collies are known for being gentle, loyal, and intelligent, often forming close bonds with their families. Many remain sweet, devoted companions well into their senior years.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Collies as they age, and joint health is a frequent topic for active herding breeds generally. Owners often find that adjusting (rather than eliminating) exercise routines helps senior Collies stay comfortable and engaged.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'High (Rough Collie) or low-moderate (Smooth Collie) — regular brushing needed, heavy seasonal shedding', averageLifespan: '12–14 years' },
    exercise: `Collies were bred to herd and do well with regular, moderate-to-vigorous exercise — daily walks and active play suit this breed well. Many stay eager to be involved in family activity well into their senior years, just at a gentler pace over time.`
  },

  'portuguese water dog': {
    displayName: 'Portuguese Water Dog',
    typicalWeight: '35–60 lb',
    history: `Portuguese Water Dogs originated along the coast of Portugal, bred by fishermen to retrieve nets, herd fish, and carry messages between boats — genuine working water dogs, not just companions.`,
    temperament: `Portuguese Water Dogs are known for being intelligent, energetic, and people-oriented, often described as natural athletes. Many remain playful and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Portuguese Water Dog owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — curly, non-shedding coat needs regular professional grooming', averageLifespan: '11–13 years' },
    exercise: `Portuguese Water Dogs were bred for real working stamina, and most need substantial daily exercise and mental engagement to stay content. Given their history, many genuinely love to swim — it's an excellent, joint-friendly option for this athletic breed at any age.`
  },

  'shiba inu': {
    displayName: 'Shiba Inu',
    pronunciation: 'SHEE-bah EE-noo',
    typicalWeight: '17–23 lb',
    history: `Shiba Inus originated in Japan, among the oldest and smallest native Japanese breeds, originally used for hunting small game in mountainous terrain.`,
    temperament: `Shiba Inus are known for being alert, independent, and confident, often described as having a cat-like, self-possessed personality. Many remain spirited and dignified well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic for Shiba Inus as they age, and eye health is also sometimes discussed. Because Shibas are naturally independent, owners often find it takes a bit more attentiveness to catch subtle behavioral changes early.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'Moderate — double coat sheds heavily twice a year', averageLifespan: '13–16 years' },
    exercise: `Shiba Inus generally do well with regular walks and play, and most don't need extreme exercise despite their alert, active nature. Given their independent streak, many owners find secure leashing and fencing matter more for this breed than most, since Shibas can be quick to wander if given the chance.`
  },

  'west highland white terrier': {
    displayName: 'West Highland White Terrier',
    typicalWeight: '15–20 lb',
    history: `West Highland White Terriers originated in Scotland, bred to hunt vermin on farms, with their distinctive white coat reportedly favored so hunters could distinguish them from prey in the field.`,
    temperament: `Westies are known for being confident, feisty, and affectionate, often carrying real terrier spirit despite their small size. Many stay alert and playful well into their senior years.`,
    seniorPatterns: `Skin health is a commonly discussed topic for Westies throughout life, and dental health is a frequent topic for small breeds generally. Owners often find that regular grooming and vet checkups alongside their own tracking help catch changes early.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'High — coarse coat needs regular brushing and professional trimming', averageLifespan: '13–15 years' },
    exercise: `Westies generally do well with regular walks and active play — this breed has real terrier energy despite its small size. Many enjoy digging and chasing games that tap into their original vermin-hunting instincts, and owners often find mental engagement matters as much as physical exercise for this breed.`
  },

  'australian cattle dog': {
    displayName: 'Australian Cattle Dog',
    typicalWeight: '35–50 lb',
    history: `Australian Cattle Dogs were developed in Australia to herd cattle over long distances in harsh conditions, bred from a mix of working dogs including dingo ancestry for toughness and stamina.`,
    temperament: `Cattle Dogs are known for being intelligent, tireless, and fiercely loyal, often bonding closely with one person or family. Many stay driven and mentally sharp well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Cattle Dog owners as the breed ages, given their athletic build and activity level earlier in life. Owners often find that keeping a senior Cattle Dog mentally engaged, even at a gentler pace, supports overall wellbeing.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance short coat, moderate shedding', averageLifespan: '12–16 years' },
    exercise: `Cattle Dogs were bred for tireless working stamina, and most need substantial daily exercise along with real mental engagement — this is one of the higher-energy breeds here. Owners commonly find that under-exercised Cattle Dogs can become restless or nippy, since herding instinct needs a real outlet.`
  },

  'whippet': {
    displayName: 'Whippet',
    typicalWeight: '25–40 lb',
    history: `Whippets originated in England, developed by crossing small greyhound-type dogs for both companionship and informal racing, sometimes called "the poor man's racehorse."`,
    temperament: `Whippets are known for being gentle, calm indoors, and surprisingly affectionate, often described as couch-loving athletes. Many stay sweet-natured and content well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic for Whippets as they age, given their athletic build earlier in life. Because Whippets have very little body fat, owners often find this breed is more sensitive to cold, which can become more noticeable with age.`,
    atAGlance: { energyLevel: 'Moderate (bursts of high intensity)', grooming: 'Very low-maintenance short coat', averageLifespan: '12–15 years' },
    exercise: `Whippets are true sprinters — most do well with a mix of short bursts of vigorous running and plenty of relaxed downtime, rather than long endurance activity. Given their thin coat and low body fat, many owners find their Whippet needs a coat or sweater in cold weather, at any age.`
  },

  'dalmatian': {
    displayName: 'Dalmatian',
    typicalWeight: '45–70 lb',
    history: `Dalmatians' exact origins are debated, but the breed has a long history as a carriage dog, running alongside horse-drawn vehicles, and later became associated with firehouses in America.`,
    temperament: `Dalmatians are known for being energetic, outgoing, and loyal, often forming strong bonds with their families. Many stay playful and active well into their senior years.`,
    seniorPatterns: `Urinary and kidney health is one of the most commonly discussed topics for Dalmatians throughout life, given a well-documented breed tendency toward urate stones, and it's an area many vets pay particular attention to. Hearing is also a frequently discussed topic for the breed. Staying consistent with regular vet checkups alongside your own tracking is commonly recommended.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat, but sheds noticeably year-round', averageLifespan: '11–13 years' },
    exercise: `Dalmatians were bred for real endurance work, and most need substantial daily exercise to stay content and avoid restlessness. Owners often find that consistent daily activity, paired with the diet considerations many vets discuss for this breed specifically, supports overall comfort at any age.`
  },

  'wirehaired pointing griffon': {
    displayName: 'Wirehaired Pointing Griffon',
    typicalWeight: '35–60 lb',
    history: `Wirehaired Pointing Griffons were developed in the Netherlands and France as versatile hunting dogs, bred to work effectively in harsh terrain and weather with a distinctive wiry, weather-resistant coat.`,
    temperament: `Griffons are known for being intelligent, affectionate, and eager to please, often described as a bit more laid-back than some other pointing breeds. Many stay engaged and willing well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Griffon owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate — wiry coat needs regular hand-stripping or trimming', averageLifespan: '12–14 years' },
    exercise: `Griffons were bred for versatile fieldwork and do best with real daily exercise — a short walk alone typically isn't enough for this breed. Many enjoy training and retrieving games, and owners often find this breed responds well to having a "job" alongside physical activity.`
  },

  'giant schnauzer': {
    displayName: 'Giant Schnauzer',
    typicalWeight: '55–85 lb',
    history: `Giant Schnauzers were developed in Germany by scaling up the Standard Schnauzer, originally used to drive cattle and guard breweries and farms.`,
    temperament: `Giant Schnauzers are known for being intelligent, confident, and protective, often needing consistent training to channel their strength and drive productively. Many remain alert and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Giant Schnauzer owners as the breed ages, given their large size and activity level earlier in life. Owners often find that consistent structure and training remain valuable even as exercise needs shift with age.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — wiry coat needs regular trimming/stripping', averageLifespan: '12–15 years' },
    exercise: `Giant Schnauzers need substantial daily exercise and real mental engagement — this is a genuine working breed, not just a large companion dog. Owners commonly find that structured training alongside physical activity suits this intelligent, driven breed particularly well.`
  },

  'italian greyhound': {
    displayName: 'Italian Greyhound',
    typicalWeight: '7–14 lb',
    history: `Italian Greyhounds are among the oldest toy breeds, with a history tracing back over 2,000 years, developed as a smaller companion version of the sighthound family and favored by European nobility.`,
    temperament: `Italian Greyhounds are known for being gentle, affectionate, and sensitive, often forming close bonds with their people. Many stay alert and playful well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Italian Greyhounds, as it is for many small breeds. Joint health is also sometimes discussed, given the breed's fine bone structure. Because Italian Greyhounds have very little body fat, owners often find this breed is more sensitive to cold, which can become more noticeable with age.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Very low-maintenance short coat', averageLifespan: '14–15 years' },
    exercise: `Italian Greyhounds generally do well with short walks and some active play — this isn't a breed that needs vigorous prolonged exercise despite its sighthound heritage. Given their thin coat and delicate build, many owners find a coat or sweater helpful in cold weather, and are commonly careful about jumping from furniture given how fine-boned this breed is.`
  },

  'weimaraner': {
    displayName: 'Weimaraner',
    pronunciation: 'VY-mar-ah-ner',
    typicalWeight: '55–90 lb',
    history: `Weimaraners were developed in Germany in the early 1800s by nobility for big-game hunting, later adapted as versatile bird dogs as game populations changed.`,
    temperament: `Weimaraners are known for being intelligent, energetic, and deeply bonded to their people — often nicknamed "velcro dogs" for how closely they like to stay by their owner's side. Many remain eager and attentive well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Weimaraner owners as the breed ages, given their athletic build and activity level earlier in life. Owners often find that keeping a senior Weimaraner mentally and physically engaged, at a gentler pace, supports overall wellbeing.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance short coat', averageLifespan: '10–13 years' },
    exercise: `Weimaraners were bred for all-day fieldwork, and most genuinely need extensive daily exercise — this is one of the higher-energy breeds here. Because they're so closely bonded to their people, many do best exercising alongside their owner, and can become anxious or destructive without enough activity.`
  },

  'samoyed': {
    displayName: 'Samoyed',
    pronunciation: 'SAM-uh-yed',
    typicalWeight: '35–65 lb',
    history: `Samoyeds originated with the Samoyedic peoples of Siberia, bred as versatile working dogs for herding reindeer, pulling sleds, and providing warmth in extreme cold.`,
    temperament: `Samoyeds are known for being friendly, gentle, and famously good-natured, often described by their signature "Sammy smile." Many stay sociable and playful well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Samoyed owners as the breed ages, and eye health is also sometimes discussed. Given their heavy coat, many owners find their Samoyed is more comfortable in cooler weather, which can become more noticeable as the breed ages.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — thick double coat needs regular brushing, heavy seasonal shedding', averageLifespan: '12–14 years' },
    exercise: `Samoyeds were bred for real working stamina in cold climates, and most need regular, substantial exercise to stay content. Given their heavy coat, many owners find their Samoyed does best exercising in cooler parts of the day and taking it easier when it's warm out.`
  },

  'chesapeake bay retriever': {
    displayName: 'Chesapeake Bay Retriever',
    typicalWeight: '55–80 lb',
    history: `Chesapeake Bay Retrievers were developed in the Chesapeake Bay region of the U.S., bred to retrieve waterfowl in cold, rough water — valued for a distinctive water-resistant, oily coat.`,
    temperament: `Chessies are known for being loyal, intelligent, and a bit more independent than other retriever breeds, often described as devoted to their family but naturally protective. Many remain active and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Chessie owners as the breed ages, given their size and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance coat, but sheds and can have a distinct odor if not bathed regularly', averageLifespan: '10–13 years' },
    exercise: `Chessies were bred for demanding water work in rough conditions, and most need substantial daily exercise to stay content. Many genuinely love to swim, which echoes their original purpose and tends to be an easier option on the joints than running.`
  },

  'scottish terrier': {
    displayName: 'Scottish Terrier',
    typicalWeight: '18–22 lb',
    history: `Scottish Terriers originated in Scotland, bred to hunt vermin and small game in rocky terrain, and are among the oldest and most recognizable terrier breeds.`,
    temperament: `Scotties are known for being independent, confident, and dignified, often described as having real terrier spirit in a compact frame. Many stay alert and spirited well into their senior years.`,
    seniorPatterns: `Joint health and skin health are commonly discussed topics for Scotties as they age. Dental health is also a frequent topic for the breed. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — wiry coat needs regular trimming/stripping', averageLifespan: '11–13 years' },
    exercise: `Scotties generally do well with regular walks and play — this breed has real terrier energy but doesn't need extreme exercise. Many enjoy activities that let them dig or explore, tapping into their original vermin-hunting instincts.`
  },

  'german wirehaired pointer': {
    displayName: 'German Wirehaired Pointer',
    typicalWeight: '50–70 lb',
    history: `German Wirehaired Pointers were developed in Germany as an all-purpose hunting breed, bred for a rugged, weather-resistant coat and versatility across land and water.`,
    temperament: `GWPs are known for being intelligent, bold, and eager to work, often described as a bit more independent than the German Shorthaired Pointer. Many stay active and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among GWP owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Moderate — wiry coat needs regular hand-stripping or trimming', averageLifespan: '12–14 years' },
    exercise: `GWPs were bred for demanding, all-day fieldwork, and most need substantial daily exercise to stay content — a plain walk typically isn't enough for this breed. Owners commonly find that a well-exercised GWP is noticeably calmer and easier to live with at home.`
  },

  'bloodhound': {
    displayName: 'Bloodhound',
    typicalWeight: '80–110 lb',
    history: `Bloodhounds are among the oldest scent hound breeds, with ancestry tracing back centuries in Europe, prized for an extraordinarily precise sense of smell still used in tracking work today.`,
    temperament: `Bloodhounds are known for being gentle, affectionate, and famously determined once on a scent, often described as having a calm, easygoing nature at home. Many remain sociable and mellow well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Bloodhound owners given their large size, and ear health is also frequently discussed given their long, low-hanging ears. Weight management is another common topic, since extra weight adds real strain to large joints.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Low-maintenance short coat, though some drooling is common', averageLifespan: '10–12 years' },
    exercise: `Bloodhounds generally do well with regular, moderate exercise — this breed has real stamina for scent-tracking but doesn't need vigorous running. Given their size, many owners are mindful about controlled leash walks, since a Bloodhound following a scent can be surprisingly hard to redirect.`
  },

  'russell terrier': {
    displayName: 'Russell Terrier',
    typicalWeight: '9–15 lb',
    history: `Russell Terriers were developed in England, bred by Reverend John Russell specifically for fox hunting — small enough to follow quarry underground, but with real stamina and drive.`,
    temperament: `Russell Terriers are known for being bold, energetic, and famously fearless, often carrying far more intensity than their small size suggests. Many stay spirited and alert well into their senior years.`,
    seniorPatterns: `Joint (patella) health is a commonly discussed topic for Russell Terriers, as it is for many small, athletic breeds. Dental health is also a frequent topic. Because this breed stays so active, owners sometimes find it takes a bit more attention to notice subtle slowdowns.`,
    atAGlance: { energyLevel: 'Very High', grooming: 'Low-maintenance coat (smooth or broken variety)', averageLifespan: '13–16 years' },
    exercise: `Russell Terriers were bred for real hunting stamina, and most need substantial daily exercise despite their small size — this isn't a breed that's satisfied with a short walk. Owners commonly find that under-exercised Russells can become destructive or overly vocal, since this breed genuinely needs an outlet for its energy.`
  },

  'staffordshire bull terrier': {
    displayName: 'Staffordshire Bull Terrier',
    typicalWeight: '24–38 lb',
    history: `Staffordshire Bull Terriers originated in England, developed from bull-baiting stock and later refined into a companion and working breed known for its strength and affectionate nature.`,
    temperament: `Staffies are known for being confident, affectionate, and famously good with people — often described as a "nanny dog" for their gentleness with family. Many remain playful and devoted well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic for Staffies as they age, and skin health is also sometimes discussed. Weight management is frequently discussed too, since this muscular breed can gain weight if activity decreases.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '12–14 years' },
    exercise: `Staffies are a muscular, athletic breed that generally needs regular, vigorous exercise to stay content and fit. Many enjoy interactive play and training, and owners often find this breed's strength and enthusiasm make consistent activity especially important for weight management.`
  },

  'akita': {
    displayName: 'Akita',
    pronunciation: 'ah-KEE-tah',
    typicalWeight: '70–130 lb',
    history: `Akitas originated in Japan, bred as large working dogs for guarding and big-game hunting, and are considered a national symbol of loyalty and strength in their home country.`,
    temperament: `Akitas are known for being dignified, loyal, and independent, often bonding intensely with their family while remaining reserved with strangers. Many stay watchful and composed well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Akita owners given their large size, and thyroid health is also sometimes discussed for the breed. Weight management is frequently discussed too, since extra weight adds real strain to large joints.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'High — thick double coat sheds heavily twice a year', averageLifespan: '10–13 years' },
    exercise: `Akitas generally do well with regular, moderate exercise — daily walks and some play suit this dignified breed well, and this isn't a breed that needs to run for hours. Given their size and independent nature, many owners find structured, leashed exercise works better than off-leash free play.`
  },

  'saint bernard': {
    displayName: 'Saint Bernard',
    typicalWeight: '120–180 lb',
    history: `Saint Bernards originated in the Swiss Alps, bred by monks at the Great St. Bernard Hospice to rescue travelers stranded in snow, and remain one of the most recognized giant breeds in the world.`,
    temperament: `Saint Bernards are known for being gentle, patient, and famously good-natured despite their massive size. Many remain calm, affectionate companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Saint Bernard owners as the breed ages. Owners often work closely with their vets on weight management and mobility support, since extra strain on joints and the heart can be more noticeable in giant breeds.`,
    atAGlance: { energyLevel: 'Low', grooming: 'High — thick coat sheds heavily, drooling is common', averageLifespan: '8–10 years' },
    exercise: `Despite their massive size, Saint Bernards typically need only modest exercise — short, easy walks are usually plenty. Because giant breeds grow so quickly early on, many owners are especially mindful of avoiding high-impact activity like jumping while a Saint Bernard is still young, to go easy on developing joints. Heat is also a real consideration for this breed given their size and heavy coat.`
  },

  'boykin spaniel': {
    displayName: 'Boykin Spaniel',
    pronunciation: 'BOY-kin',
    typicalWeight: '25–40 lb',
    history: `Boykin Spaniels were developed in South Carolina specifically for waterfowl hunting in the swamps and rivers of the region, and are the state dog of South Carolina.`,
    temperament: `Boykin Spaniels are known for being eager, friendly, and energetic, often described as having a real love of water and retrieving. Many stay active and engaged well into their senior years.`,
    seniorPatterns: `Ear health is a commonly discussed topic for Boykins given their long ears, and joint health is a frequent topic for active sporting breeds generally. Owners often find that adjusting exercise routines helps senior Boykins stay comfortable.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate — curly coat needs regular brushing, ears need routine cleaning', averageLifespan: '10–15 years' },
    exercise: `Boykin Spaniels were bred for active water-based hunting work, and most do well with real daily exercise — many genuinely love to swim, which echoes their original purpose. Owners often find a well-exercised Boykin is a calmer, easier companion at home.`
  },

  'cardigan welsh corgi': {
    displayName: 'Cardigan Welsh Corgi',
    typicalWeight: '25–38 lb',
    history: `Cardigan Welsh Corgis are one of two Corgi breeds (alongside the Pembroke), developed in Wales as herding dogs and generally considered the older of the two breeds, distinguished by a longer tail.`,
    temperament: `Cardigans are known for being smart, alert, and affectionate, sharing much of the Pembroke's herding instinct and personality. Many stay lively and food-motivated well into their senior years.`,
    seniorPatterns: `Back and spinal health is a commonly discussed topic for Cardigans given their long body and short legs, similar to the Pembroke. Weight management is especially frequently discussed for this breed, since extra weight adds real strain to both the spine and joints.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate-high — double coat sheds heavily', averageLifespan: '12–15 years' },
    exercise: `Cardigans were bred to herd all day, and many have surprisingly high energy for their size — regular walks and active play matter for this breed. Given their long back and short legs, owners are commonly mindful about avoiding activities involving a lot of jumping, to go easy on the spine.`
  },

  'great pyrenees': {
    displayName: 'Great Pyrenees',
    pronunciation: 'GRAYT PEER-uh-nees (not "puh-REE-neez")',
    typicalWeight: '85–120 lb',
    history: `Great Pyrenees were developed in the Pyrenees Mountains between France and Spain, bred to guard livestock against predators, often working independently for long stretches with minimal human direction.`,
    temperament: `Great Pyrenees are known for being calm, gentle, and independent, often described as patient family guardians. Many remain composed, watchful companions well into their senior years.`,
    seniorPatterns: `Given their large size, joint health is a commonly discussed topic among Great Pyrenees owners as the breed ages. Heart health is also a frequent topic for large working breeds generally. Owners often work with their vets on weight management to support comfort in the senior years.`,
    atAGlance: { energyLevel: 'Low-Moderate', grooming: 'High — thick double coat needs regular brushing, heavy seasonal shedding', averageLifespan: '10–12 years' },
    exercise: `Great Pyrenees generally do well with moderate exercise — this breed was bred to patrol calmly rather than run, and most are content with regular walks rather than vigorous activity. Given their heavy coat, many owners find their Pyrenees more comfortable in cooler weather and prefer to take it easy when it's warm out.`
  },

  'miniature pinscher': {
    displayName: 'Miniature Pinscher',
    pronunciation: 'PIN-sher (not "pincher")',
    typicalWeight: '8–11 lb',
    history: `Miniature Pinschers originated in Germany, developed as small farm dogs to hunt rodents — despite the name, they are not a scaled-down Doberman, though the two breeds share a similar look.`,
    temperament: `Min Pins are known for being confident, energetic, and famously fearless, often described as having a "big dog" attitude in a small frame. Many stay spirited and alert well into their senior years.`,
    seniorPatterns: `Joint (patella) health is a commonly discussed topic for Min Pins, as it is for many small, athletic breeds. Dental health is also a frequent topic. Because Min Pins are so small, owners often find it easier to spot subtle changes early.`,
    atAGlance: { energyLevel: 'High', grooming: 'Low-maintenance short coat', averageLifespan: '12–16 years' },
    exercise: `Min Pins generally do well with regular walks and active play — this small breed has real energy and benefits from consistent daily activity. Given their small size, owners are commonly careful about jumping from furniture or rough play.`
  },

  'cairn terrier': {
    displayName: 'Cairn Terrier',
    typicalWeight: '13–14 lb',
    history: `Cairn Terriers originated in Scotland, among the oldest terrier breeds, bred to hunt vermin among the rocky cairns (piles of stones) of the Scottish Highlands.`,
    temperament: `Cairn Terriers are known for being spirited, curious, and independent, often carrying real terrier energy in a small package. Many stay playful and alert well into their senior years.`,
    seniorPatterns: `Joint (patella) health and dental health are commonly discussed topics for Cairn Terriers, as they are for many small breeds. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'Moderate — wiry coat needs regular brushing and occasional trimming', averageLifespan: '13–15 years' },
    exercise: `Cairn Terriers generally do well with regular walks and active play — this breed has real terrier spirit and enjoys digging and exploring. Owners often find mental engagement, like puzzle toys or training, suits this intelligent, curious breed as much as physical exercise does.`
  },

  'nova scotia duck tolling retriever': {
    displayName: 'Nova Scotia Duck Tolling Retriever',
    pronunciation: '"Tolling" rhymes with "rolling," not "toe-ling"',
    typicalWeight: '35–50 lb',
    history: `Nova Scotia Duck Tolling Retrievers were developed in Canada, bred to lure ("toll") waterfowl within range by playing at the water's edge, then retrieve birds once hunters fired — a genuinely unique hunting method.`,
    temperament: `Tollers are known for being intelligent, energetic, and eager to please, often described as needing both physical activity and mental engagement. Many stay active and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Toller owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'Moderate — water-resistant coat needs regular brushing, moderate shedding', averageLifespan: '12–14 years' },
    exercise: `Tollers were bred for an active, engaging hunting role, and most need substantial daily exercise along with mental stimulation — a plain walk often isn't enough. Many genuinely love to swim and retrieve, and owners often find this breed thrives with a real job or structured activity.`
  },

  'airedale terrier': {
    displayName: 'Airedale Terrier',
    typicalWeight: '40–65 lb',
    history: `Airedale Terriers originated in England's Aire Valley, developed as an all-purpose working terrier for hunting, guarding, and later military and police work — often called the "King of Terriers" for their size.`,
    temperament: `Airedales are known for being confident, intelligent, and versatile, often described as having real terrier spirit in a larger frame. Many stay alert and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Airedale owners as the breed ages, given their size and activity level earlier in life. Skin health is also sometimes discussed. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — wiry coat needs regular trimming/stripping', averageLifespan: '11–14 years' },
    exercise: `Airedales were bred for versatile working roles, and most need substantial daily exercise and mental engagement to stay content. Owners commonly find that training alongside physical activity suits this intelligent, independent breed particularly well.`
  },

  'great swiss mountain dog': {
    displayName: 'Great Swiss Mountain Dog',
    typicalWeight: '85–140 lb',
    history: `Great Swiss Mountain Dogs originated in the Swiss Alps, bred as versatile farm dogs for driving cattle, pulling carts, and guarding property — one of the oldest Swiss breeds.`,
    temperament: `Great Swiss Mountain Dogs are known for being calm, confident, and loyal, often described as gentle giants with a strong work ethic. Many remain steady, devoted companions well into their senior years.`,
    seniorPatterns: `Given their large size, joint health and heart health are both commonly discussed topics among Great Swiss Mountain Dog owners as the breed ages. Owners often work closely with their vets on weight management, since extra strain on joints and the heart can be more noticeable in large breeds.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Moderate — double coat sheds seasonally', averageLifespan: '8–11 years' },
    exercise: `Great Swiss Mountain Dogs generally do well with moderate exercise — hiking or pulling-style activities echo their working heritage, though this isn't a breed that needs to run for hours. Because giant breeds grow quickly early on, many owners are especially mindful of avoiding high-impact activity while this breed is still young.`
  },

  'chinese crested': {
    displayName: 'Chinese Crested',
    typicalWeight: '8–12 lb',
    history: `Chinese Cresteds have a debated history, believed to have been developed from African hairless dogs and spread via Chinese trading ships, prized as companion dogs for centuries.`,
    temperament: `Chinese Cresteds are known for being affectionate, playful, and people-oriented, often forming close bonds with their owners. Many stay lively and attentive well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Chinese Cresteds, as it is for many small breeds. For the hairless variety, skin care is also a frequent topic, since exposed skin needs protection from sun and cold. Regular vet checkups alongside your own tracking are commonly recommended.`,
    atAGlance: { energyLevel: 'Moderate', grooming: 'Varies by variety — hairless needs skin care and sun/cold protection; powderpuff (coated) needs regular brushing', averageLifespan: '13–15 years' },
    exercise: `Chinese Cresteds generally do well with short walks and indoor play — this breed doesn't need extensive exercise given its size. For the hairless variety, many owners are mindful about sun exposure and cold weather, since this breed's skin needs more protection than a typical coated dog at any age.`
  },

  'irish setter': {
    displayName: 'Irish Setter',
    typicalWeight: '60–70 lb',
    history: `Irish Setters were developed in Ireland as bird-hunting dogs, bred to "set" (freeze and point) upon finding game, and became popular worldwide for their striking red coat and elegant build.`,
    temperament: `Irish Setters are known for being friendly, energetic, and outgoing, often described as having a joyful, sociable personality. Many stay playful and engaged well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Irish Setter owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina before other signs appear.`,
    atAGlance: { energyLevel: 'High', grooming: 'High — silky coat needs regular brushing', averageLifespan: '12–15 years' },
    exercise: `Irish Setters were bred for active fieldwork, and most do best with real daily exercise — a short walk alone typically isn't enough for this breed. Many enjoy running and retrieving games, and owners often find a well-exercised Setter is a calmer, easier companion at home.`
  },

  'biewer terrier': {
    displayName: 'Biewer Terrier',
    pronunciation: 'BEE-ver',
    typicalWeight: '4–8 lb',
    history: `Biewer Terriers originated in Germany in the 1980s, developed from a genetic color variation within the Yorkshire Terrier line into their own recognized breed.`,
    temperament: `Biewer Terriers are known for being affectionate, playful, and people-oriented, sharing much of the Yorkshire Terrier's lively personality. Many stay alert and attentive well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Biewer Terriers, as it is for many small breeds. Joint (patella) health is also sometimes discussed. Because Biewers are so small, owners often find it easier to notice subtle changes early.`,
    atAGlance: { energyLevel: 'Moderate-High', grooming: 'High — silky coat needs regular brushing and trims', averageLifespan: '12–15 years' },
    exercise: `Biewer Terriers generally do well with short walks and active indoor play — this small breed doesn't need extensive exercise, though many stay lively and enjoy staying active. Given their small size, owners are commonly careful about jumping from furniture or rough handling.`
  },

  'irish wolfhound': {
    displayName: 'Irish Wolfhound',
    typicalWeight: '105–180 lb',
    history: `Irish Wolfhounds are among the tallest dog breeds, with ancestry tracing back over 2,000 years in Ireland, originally bred to hunt wolves and large game.`,
    temperament: `Irish Wolfhounds are known for being gentle, dignified, and famously calm despite their imposing size — often described as "gentle giants." Many remain sweet, easygoing companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Irish Wolfhound owners as the breed ages. Owners often work closely with their vets on weight management and mobility support, since this is one of the largest breeds and giant-breed lifespans tend to run shorter.`,
    atAGlance: { energyLevel: 'Low-Moderate', grooming: 'Moderate — wiry coat needs regular brushing', averageLifespan: '6–8 years' },
    exercise: `Despite their massive size, Irish Wolfhounds typically need only moderate exercise — a couple of relaxed walks a day is often enough, and many are content resting most of the day. Because giant breeds grow so quickly early on, many owners are especially mindful of avoiding high-impact activity like jumping or long runs while a Wolfhound is still young, to go easy on developing joints.`
  },

  'mixed breed': {
    displayName: 'Mixed Breed',
    typicalWeight: 'Varies widely',
    history: `Mixed-breed dogs draw from two or more breed lineages, which often gives them a broader, more varied genetic background than purebred dogs. This diversity is sometimes associated with fewer breed-specific hereditary conditions, though every dog's health history is individual.`,
    temperament: `Temperament in mixed-breed dogs varies widely and depends on their specific ancestry, individual personality, and upbringing — there's no single generalization that applies broadly.`,
    seniorPatterns: `Because mixed-breed dogs don't share one specific health profile, tracking your own dog's individual patterns over time — rather than relying on breed generalizations — is especially valuable. That's exactly what consistent weekly check-ins are for.`,
    exercise: `Because mixed-breed dogs draw from such varied ancestry, there's no single exercise routine that fits broadly — a dog's actual size, build, and energy level are the real guide here, not a breed generalization. Watching how your own dog responds to activity over time, and adjusting from there, tends to be far more useful than following advice written for one specific breed.`
  }
};

const GENERIC_BREED_GUIDE = {
  displayName: 'Senior Dogs',
  typicalWeight: 'Varies by breed',
  history: `Dogs have been companions to humans for thousands of years, with countless breeds and mixes developed for different purposes — from herding and hunting to companionship. Every dog's individual history and genetics shape how they age.`,
  temperament: `Every dog's temperament is shaped by a mix of genetics, upbringing, and individual personality — general breed traits are a starting point, not a guarantee.`,
  seniorPatterns: `As dogs enter their senior years, changes in mobility, energy, appetite, and alertness are common across breeds, though the timing and severity vary widely from dog to dog. Regular tracking is one of the most reliable ways to notice real changes early, rather than relying on memory or breed-level assumptions.`,
  exercise: `This breed isn't part of our detailed guide library yet, so there's no breed-specific guidance to share here. Your dog's actual size, build, and energy level are the best guide — watching how they respond to activity over time, and adjusting from there, is far more useful than generic advice written for a different breed.`
};

// ============================================
// BREED MATCHING — layered fallback chain (STEP P11, Stage 2)
// breed is a free-text field at signup (no dropdown/autocomplete), so a
// single exact-match lookup was silently sending a real, previously
// invisible share of dogs to the generic fallback (typos, "X mix",
// nicknames, or real breeds genuinely outside the curated list) — and
// isSeniorForBreed/isOverweightForBreed both depend on this same lookup,
// so a bad match degraded those too. Each layer below is tried in order,
// first match wins. See Decision 1 in docs/Breed_Guide_Expansion_Build.md
// for the full design reasoning this implements. No signup UI change —
// this is purely a smarter read of the same senior_dogs.breed field.
// ============================================

// c. Alias map — short nicknames/abbreviations that substring matching
// (layer b) can't reach, since here the INPUT is shorter than the curated
// KEY, the opposite direction of what layer b handles. Exact-match only
// against the full normalized breed string (not itself substring-matched),
// to keep this layer's risk low and easy to reason about. Deliberately
// excludes "bulldog" (French vs. English/American — English Bulldog isn't
// even in the curated list, so aliasing it to French Bulldog would be
// actively wrong, not just imprecise), "chi" (too short, real false-
// positive risk), and "pit bull"/"pitbull" (no curated match exists to
// alias to at all — correctly falls through to generic). See Decision 1c.
const BREED_ALIASES = {
  'lab': 'labrador',
  'golden': 'golden retriever',
  'gsd': 'german shepherd',
  'frenchie': 'french bulldog',
  'doxie': 'dachshund',
  'wiener dog': 'dachshund',
  'yorkie': 'yorkshire terrier',
  'husky': 'siberian husky',
  'doberman': 'doberman pinscher',
  'gsp': 'german shorthaired pointer',
  'berner': 'bernese mountain dog',
  'cavalier': 'cavalier king charles spaniel',
  'mini schnauzer': 'miniature schnauzer',
  'rottie': 'rottweiler',
  'newfie': 'newfoundland',
  'ridgeback': 'rhodesian ridgeback',
  'pom': 'pomeranian',
  'shitzu': 'shih tzu',
  // Only corgi in the curated list — a Cardigan Welsh Corgi owner typing
  // "corgi" gets the Pembroke guide. A known simplification, not a bug.
  'corgi': 'pembroke welsh corgi'
};

// Standard Levenshtein edit distance, used by layer d below. Inputs here
// are always short breed-name strings, so no need for a more optimized
// algorithm than the classic two-row dynamic-programming version.
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;
  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,   // insertion
        prevRow[j] + 1,       // deletion
        prevRow[j - 1] + cost // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }
  return prevRow[n];
}

// d. Fuzzy match, last resort, conservative on two axes at once (see
// Decision 1d): an absolute edit-distance cap AND that distance kept small
// relative to the candidate key's own length, so a short key like "pug"
// can't absorb an unrelated short input just because an absolute distance
// of 2 looks small in isolation — for keys short enough that the ratio cap
// rounds to 0, fuzzy matching is effectively disabled for that key
// entirely, which is intentional, not a bug. Requires a minimum input
// length before running at all, and only accepts a match when exactly one
// curated key qualifies — two keys landing within threshold of the same
// input is treated as ambiguous and rejected, not resolved by picking the
// closer one, since at this distance either could plausibly be intended.
// This is what keeps "Labradoodle" (a real different breed) from matching
// "Labrador" as if it were a typo — the edit distance between them is
// larger than either axis of this cap allows.
const FUZZY_MIN_INPUT_LENGTH = 4;
const FUZZY_MAX_ABSOLUTE_DISTANCE = 2;
const FUZZY_MAX_DISTANCE_RATIO = 0.25;

function findFuzzyBreedMatch(normalized) {
  if (normalized.length < FUZZY_MIN_INPUT_LENGTH) return null;
  const candidates = [];
  for (const key of Object.keys(BREED_GUIDES)) {
    const maxDistance = Math.min(FUZZY_MAX_ABSOLUTE_DISTANCE, Math.floor(key.length * FUZZY_MAX_DISTANCE_RATIO));
    if (maxDistance <= 0) continue; // key too short for fuzzy matching to ever be safe
    if (levenshteinDistance(normalized, key) <= maxDistance) candidates.push(key);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function getBreedGuide(breedName) {
  if (!breedName) return GENERIC_BREED_GUIDE;
  const normalized = breedName.trim().toLowerCase();

  // a. Exact match (original behavior, unchanged).
  if (BREED_GUIDES[normalized]) return BREED_GUIDES[normalized];

  // b. Substring match — the INPUT contains a curated KEY (handles
  // "Golden Retriever mix", "Golden Retriever - senior", etc.). Direction
  // matters: this is the opposite check from a nickname lookup, which is
  // exactly why aliases (c) are their own separate layer below, not folded
  // into this one.
  const substringKey = Object.keys(BREED_GUIDES).find(key => normalized.includes(key));
  if (substringKey) return BREED_GUIDES[substringKey];

  // c. Alias map.
  if (BREED_ALIASES[normalized]) return BREED_GUIDES[BREED_ALIASES[normalized]];

  // d. Fuzzy edit-distance match.
  const fuzzyKey = findFuzzyBreedMatch(normalized);
  if (fuzzyKey) return BREED_GUIDES[fuzzyKey];

  // e. Fall-through logging — nothing matched. This has been completely
  // invisible since the feature was built; logging the raw string is what
  // makes it possible to ever see, and eventually prioritize, the real
  // long tail of un-matched breed strings.
  console.log(`ℹ️ No breed guide match for "${breedName}" — using generic fallback`);
  return GENERIC_BREED_GUIDE;
}

// ============================================
// SENIOR-BY-BREED-SIZE + WEIGHT-RANGE HELPERS
// Nothing here is stored — both the size tier and the senior flag are
// derived live from a breed's existing typicalWeight string, same pattern
// as the live week-number/streak calculations elsewhere in this file.
// Real vet-consensus senior-age ranges (larger/giant breeds age faster):
//   Giant  (avg >115 lb): senior at 5
//   Large  (avg 50-115 lb): senior at 6
//   Medium (avg 25-50 lb): senior at 8
//   Small/Toy (avg <25 lb): senior at 10
// Giant cutoff is 115, not the naive 90 lb midpoint of the large/giant gap —
// Rottweiler/Cane Corso/Bernese Mountain Dog average 92.5-107.5 lb but are
// standard-classified as large breed, not giant, so 90 misclassified them.
// 115 keeps them Large while still catching genuinely giant breeds (Great
// Dane, Mastiff, Newfoundland all average 125+ lb).
// ============================================

// Parses a typicalWeight string like "55–80 lb" into {min, max}. Returns
// null for the two non-numeric cases ('Varies widely' for mixed breed,
// 'Varies by breed' for the generic fallback) — callers use that null to
// skip tier-specific behavior gracefully rather than showing a broken range.
function parseWeightRange(typicalWeight) {
  if (!typicalWeight) return null;
  const match = typicalWeight.match(/(\d+)\s*[–-]\s*(\d+)/);
  if (!match) return null;
  const min = parseInt(match[1], 10);
  const max = parseInt(match[2], 10);
  if (isNaN(min) || isNaN(max)) return null;
  return { min, max };
}

const SENIOR_AGE_BY_TIER = { giant: 5, large: 6, medium: 8, small: 10 };

// Mixed breed and the generic fallback have no real weight data, so they
// default to 'medium' — the safest middle-ground guess (matches the
// Medium threshold of 8, per the instructions this was built from).
function getBreedSizeTier(breedName) {
  const guide = getBreedGuide(breedName);
  const range = parseWeightRange(guide.typicalWeight);
  if (!range) return 'medium';
  const avg = (range.min + range.max) / 2;
  if (avg > 115) return 'giant';
  if (avg >= 50) return 'large';
  if (avg >= 25) return 'medium';
  return 'small';
}

function isSeniorForBreed(age, breedName) {
  if (age == null || isNaN(age)) return false;
  const tier = getBreedSizeTier(breedName);
  return age >= SENIOR_AGE_BY_TIER[tier];
}

// Direct parallel to isSeniorForBreed above: pure, nothing stored, computed
// fresh on every page load from the breed's existing typicalWeight string.
// No added margin — true only when currentWeight exceeds the parsed range's
// own max, same "just report the number, no interpretation" framing as
// compareWeightToBreedRange below. Returns false (not null) for mixed
// breed / the generic fallback, same as their weight range being
// unknowable — nothing to flag as "overweight" without a real range.
function isOverweightForBreed(currentWeight, breedName) {
  if (currentWeight == null) return false;
  const guide = getBreedGuide(breedName);
  const range = parseWeightRange(guide.typicalWeight);
  if (!range) return false;
  return currentWeight > range.max;
}

// Forward-looking copy shown on the breed guide for dogs NOT YET flagged
// senior — one per size tier (not per breed), same non-diagnostic register
// as each breed's own seniorPatterns copy above. Deliberately doesn't state
// the exact senior-age threshold, so this copy doesn't need updating if
// SENIOR_AGE_BY_TIER is ever retuned.
const NOT_YET_SENIOR_COPY = {
  giant: `Giant breeds are known for reaching their senior years earlier than smaller dogs, so it's worth starting to pay attention to joint comfort, mobility, and energy well before any real changes show up. Weight management and gentle, consistent exercise earlier in life are commonly discussed as ways to support comfort as giant breeds get older. Tracking your dog's own patterns now — while they're still young for their size — builds a clear picture that makes any future shift much easier to spot.`,
  large: `Large breeds tend to show the effects of aging a bit sooner than medium or small dogs, so it's worth keeping an eye on mobility, stamina, and joint comfort as the years pass, even well ahead of typical senior age. Consistent exercise and healthy weight management earlier in life are commonly discussed among large-breed owners as ways to support long-term comfort. Regular tracking now is the best way to know what's actually normal for your dog, so a real change stands out later.`,
  medium: `Medium-sized breeds generally age a bit more gradually than larger dogs, but it's still worth watching for early shifts in mobility, energy, and appetite as the years go by. Staying consistent with exercise and a healthy weight through adulthood is commonly discussed as good preparation for a smoother transition into the senior years. Tracking your dog's patterns now, well before any real change appears, makes it far easier to notice one later.`,
  small: `Small and toy breeds often stay playful and energetic well past the age that would be considered senior for a larger dog, and they typically reach that stage later too. It's still worth keeping an eye on dental health, joint comfort, and activity level as the years add up, since these are commonly discussed topics for small breeds at any age. Because small dogs are easier to observe closely day to day, owners often find it simple to notice subtle changes early — tracking now builds the baseline that makes that possible.`
};

function getNotYetSeniorCopy(breedName) {
  return NOT_YET_SENIOR_COPY[getBreedSizeTier(breedName)];
}

// Non-diagnostic weight-vs-breed comparison — "within/above/below," never a
// health judgment. Returns null when there's no weight yet, or when the
// breed has no real numeric range to compare against (mixed breed / generic).
function compareWeightToBreedRange(weightLbs, guide) {
  if (weightLbs == null) return null;
  const range = parseWeightRange(guide.typicalWeight);
  if (!range) return null;
  if (weightLbs < range.min) return `below the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
  if (weightLbs > range.max) return `above the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
  return `within the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
}

// ============================================
// STEP P11 Stage 3 — breed guide progressive unlock structure + shared
// trend helpers. See docs/Breed_Guide_Expansion_Build.md, Decisions 2/3.
// Nothing here is stored — the same live currentWeek calculation already
// used everywhere else drives every gate, no new columns/migrations.
// ============================================

// The breed guide's real chapter-unlock weeks. Also drives the dashboard's
// "Breed guide unlocked" card retrigger (see /dashboard/:dog_id below) —
// shared here so the two can't silently drift apart.
const BREED_GUIDE_CHAPTER_WEEKS = [2, 4, 8, 12];

// Content-expansion additions (75-breed library): a second, distinct
// disclaimer specifically about the breed content itself, placed right
// before someone starts reading it -- separate from the unconditional
// service-level vet disclaimer already at the bottom of the page (that one
// covers "not a veterinary service" / emergency guidance and is untouched).
// [dog name] is a literal placeholder, substituted per-request.
const BREED_CONTENT_DISCLAIMER_TEMPLATE = 'The breed information below reflects general, publicly available knowledge about the breed as a whole — not a diagnosis, treatment plan, or individualized assessment of [dog name]. For anything specific to your dog, talk to your vet.';

// A not-yet-unlocked chapter stays visible on the page as a locked teaser
// rather than being hidden entirely (Decision 2).
function buildLockedChapterTeaser(chapterTitle, unlockWeek) {
  return `<h2>${chapterTitle}</h2>
          <div style="background: #FAFAFA; border: 1px dashed #DDD; border-radius: 8px; padding: 20px; text-align: center;">
            <p style="margin: 0; font-size: 14px; color: #999;"><i data-lucide="lock"></i> Unlocks at Week ${unlockWeek}</p>
          </div>`;
}

// Stage 3 scope is structure only — this placeholder marks a chapter that
// IS unlocked but whose real content STEP P11 Stage 4 hasn't been built
// yet. Deliberately styled differently from the locked teaser above so the
// two states are never visually ambiguous during testing.
function buildChapterPlaceholder(chapterTitle) {
  return `<h2>${chapterTitle}</h2>
          <div style="background: #FFF8E7; border: 1px dashed #A89968; border-radius: 8px; padding: 20px;">
            <p style="margin: 0; font-size: 14px; color: #8A7A4F; font-style: italic;">This chapter is unlocked — real content coming in STEP P11 Stage 4.</p>
          </div>`;
}

// STEP P11 Stage 4 — real content for the week 8/12 chapters above,
// replacing their placeholders. Both chapters share this exact rendering
// for the per-metric trend lines, matching the <p> styling the dashboard
// already uses for the identical lines in its own Journey Summary — no
// visual drift between the two surfaces showing the same numbers.
function renderTrendLinesHtml(trendLines) {
  return trendLines.map(line => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #2C2C2C;">${line}</p>`).join('');
}

// Week 8 — mid-program check-in. Encouraging, non-diagnostic framing; the
// actual numbers come entirely from the same describeJourneyTrend /
// calculateCurrentStreak calls the dashboard uses for its own trend text,
// never a second hand-written interpretation of the data (Decision 3).
function buildJourneyChapter(dogName, trendLines, streak) {
  const streakLine = streak > 0
    ? `${dogName} has logged ${streak} week${streak === 1 ? '' : 's'} in a row.`
    : `${dogName}'s journey is just getting started.`;
  return `<h2>Your Dog's Journey</h2>
          <p>${streakLine} Here's an honest look at how things have moved since the very first baseline — not a verdict on anything, just the real numbers so far.</p>
          <div class="dog-snapshot">
            ${renderTrendLinesHtml(trendLines)}
          </div>
          <p style="font-size: 13px; color: #888; margin-top: 12px;">These are just numbers to notice. If anything here feels worth a closer look, that's a conversation for ${dogName}'s vet — not something to read into on your own.</p>`;
}

// Week 12 — program-completion framing. Same trend data as week 8
// (Decision 2: this is a framing difference, not a data difference).
// Deliberately does NOT imply logging stops here — nothing in the app
// gates or ends at week 12, this is just the originally-designed
// check-in cadence length.
function buildMilestoneChapter(dogName, trendLines, streak) {
  return `<h2>12-Week Milestone</h2>
          <p>${dogName} has built ${streak} week${streak === 1 ? '' : 's'} of real, consistent data — exactly the kind of history that makes patterns worth noticing instead of guessing at. Here's the full picture since baseline:</p>
          <div class="dog-snapshot">
            ${renderTrendLinesHtml(trendLines)}
          </div>
          <p style="font-size: 13px; color: #888; margin-top: 12px;">12 weeks was the original check-in plan, but there's no reason to stop here — ${dogName}'s dashboard and check-ins keep working exactly the same after this point, and every week you keep logging adds to a real, growing picture.</p>
          <p style="font-size: 13px; color: #888; margin-top: 8px;">${PROGRAM_CONTINUATION_NOTE}</p>`;
}

// ============================================
// DOCUMENT LIBRARY -- 4 personalized, printable documents reusing the
// exact same pattern as the Journey Summary above: pre-rendered on-screen
// content already in the DOM at page load, a "Print / Save as PDF" button
// that calls window.print(), and a @media print block that hides
// everything else. No server-side PDF generation, no new library.
//
// Each document is a pure content-building function taking the dog record
// and returning its body HTML. buildDocumentPane() wraps that body in one
// shared Companion Commons header/disclaimer/print-button shell, so
// "consistent branding across all 4" is a single real implementation
// rather than 4 hand-copied ones that could quietly drift apart.
// ============================================

const DOCUMENT_LIBRARY_DISCLAIMER = "Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.";

// docId matches the data-doc attribute the dashboard's document-library
// menu rows use to show/hide the right pane -- see the JS handlers below.
function buildDocumentPane(docId, title, bodyHtml) {
  return `
    <div id="doc-${docId}" class="document-pane" style="display: none;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 2px solid #D4CDB8;">
        ${buildBrandLockup({ iconPx: 26, fontPx: 15 })}
      </div>
      <h2 style="margin: 0 0 16px 0; color: #2C2C2C; font-size: 20px;">${title}</h2>
      ${bodyHtml}
      <p style="margin: 24px 0 0 0; padding-top: 12px; border-top: 1px solid #eee; font-size: 12px; color: #999; line-height: 1.5;">${DOCUMENT_LIBRARY_DISCLAIMER}</p>
      <button type="button" class="print-doc-btn no-print" style="margin-top: 16px; background: #A89968; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;"><i data-lucide="printer"></i> Print / Save as PDF</button>
    </div>`;
}

// ---- Document 1: Vet Visit Guide ----
const VET_VISIT_GUIDE_SECTIONS = [
  { heading: 'Mobility', questions: [
    "Have you noticed any changes in how {dog} gets up, moves, or handles stairs?",
    "Is there anything about {dog}'s activity level that seems different lately?",
    "Are there joint or mobility supports — ramps, rugs, supplements — you'd recommend for {dog}'s age and breed?",
    "Is there an exercise or activity level you'd recommend adjusting?"
  ]},
  { heading: 'Energy & Activity', questions: [
    "Have you noticed {dog} seeming more tired or less interested in things lately?",
    "Is there a typical range of energy levels I should expect for {dog}'s age?",
    "Could any current medications be affecting {dog}'s energy?"
  ]},
  { heading: 'Appetite & Weight', questions: [
    "Have you noticed any changes in {dog}'s appetite or eating habits?",
    "Is {dog}'s current weight where it should be for their age and breed?",
    "Should I be tracking {dog}'s weight more closely going forward?"
  ]},
  { heading: 'Cognitive & Behavior', questions: [
    "Have you noticed any changes in {dog}'s alertness, memory, or sleep patterns?",
    "Is there a point where cognitive changes in senior dogs are worth mentioning again at a future visit?",
    "Are there enrichment activities you'd recommend for {dog}'s cognitive health?"
  ]},
  { heading: 'Medications & Supplements', questions: [
    "Does {dog} need any medication or supplement refills?",
    "Are there any interactions I should know about between {dog}'s current medications and supplements?",
    "Is there anything new — a medication, supplement, or therapy — worth discussing for {dog} at this stage?"
  ]},
  { heading: 'Preventive Care', questions: [
    "Is {dog} up to date on vaccines and parasite prevention?",
    "Would you recommend any changes to {dog}'s preventive care schedule given their age?",
    "Should I be thinking about dental care or cleanings for {dog}?"
  ]},
  { heading: 'Diet & Nutrition', questions: [
    "Is {dog}'s current diet still the right fit for their age and health?",
    "Are there specific nutrients or dietary adjustments you'd recommend for a senior dog like {dog}?"
  ]},
  { heading: 'Labs & Screening', questions: [
    "Would routine bloodwork or other screening make sense for {dog} at this stage?",
    "Is there anything specific to {dog}'s breed or age that's worth screening for?"
  ]},
  { heading: 'Comfort & Quality of Life', questions: [
    "Are there comfort measures — bedding, temperature, pain management — you'd suggest for {dog} at home?",
    "How can I tell if {dog} is experiencing discomfort I might be missing day to day?"
  ]},
  { heading: 'Before You Leave', questions: [
    "Is there anything else about {dog}'s health or care I should be watching for?",
    "When would you recommend {dog}'s next visit?"
  ]}
];

function buildVetVisitGuideHtml(dog) {
  const dogName = escapeHtml(dog.dog_name);
  const sub = (s) => s.replace(/\{dog\}/g, dogName);
  const sectionsHtml = VET_VISIT_GUIDE_SECTIONS.map(section => `
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">${section.heading}</h3>
    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #2C2C2C; line-height: 1.7;">
      ${section.questions.map(q => `<li>${sub(q)}</li>`).join('')}
    </ul>`).join('');
  return `
    <p style="font-size: 14px; color: #2C2C2C; line-height: 1.6; margin: 0 0 12px 0;">${sub("Questions to help you make the most of {dog}'s next vet visit. This isn't medical advice — just a starting point to help you organize what's on your mind.")}</p>
    ${sectionsHtml}
    <div style="margin-top: 20px; padding: 16px; background: #FAFAF8; border-radius: 8px;">
      <p style="margin: 0 0 10px 0; font-size: 13px; font-weight: 600; color: #666;">Notes</p>
      <div style="border-bottom: 1px solid #ddd; height: 26px;"></div>
      <div style="border-bottom: 1px solid #ddd; height: 26px;"></div>
      <div style="border-bottom: 1px solid #ddd; height: 26px;"></div>
      <div style="border-bottom: 1px solid #ddd; height: 26px;"></div>
    </div>
    <p style="margin: 16px 0 0 0; font-size: 13px; color: #666;">${sub("Remember: you can add notes about this visit anytime in {dog}'s dashboard on Companion Commons.")}</p>`;
}

// ---- Document 2: What to Track and Why ----
const WHAT_TO_TRACK_SECTIONS = [
  { heading: 'How the scoring works', body: "Each area is scored on a scale from 0 to 10, where 0 means doing great and 10 means struggling. There's no \"passing\" or \"failing\" score — what matters most is how {dog}'s numbers move over time, not any single week on its own. A single check-in is a snapshot; the real picture builds as you keep going." },
  { heading: 'Mobility', body: "We ask about things like getting up, handling stairs, stiffness after resting, and how far {dog} typically walks. Mobility often changes gradually in senior dogs, in ways that are easy to miss day-to-day but become clearer when you're checking in regularly. Small shifts here are common as dogs age — tracking them over weeks gives you (and eventually your vet) a clearer picture than trying to remember \"was this different a month ago?\"" },
  { heading: 'Energy', body: "This tracks {dog}'s general activity and alertness level. Energy can be affected by a lot of things — age, weather, routine changes, sleep — so we're not looking for any single explanation, just a record of how things have been trending." },
  { heading: 'Appetite', body: "We ask about {dog}'s eating habits and interest in food. Appetite is one of the more sensitive early indicators owners notice, and it's also one that's easy to second-guess in the moment (\"is he just being picky today, or is this a pattern?\"). Regular check-ins turn that guesswork into an actual record." },
  { heading: 'Cognitive & Behavior', body: "Every fourth week, we also ask about orientation, memory, interest/engagement, and sleep-wake patterns. Cognitive changes in senior dogs tend to be gradual and easy to attribute to \"just getting older\" — tracking them consistently, even just once a month, can reveal patterns that are hard to see otherwise." },
  { heading: 'Why consistency matters more than any single answer', body: "None of these numbers are meant to diagnose anything, and a single high or low score on its own doesn't mean much. What's genuinely useful is the trend — how {dog}'s scores move (or don't) over weeks and months. That's what your dashboard is built to show you, and it's exactly the kind of information that's most useful to bring up at {dog}'s next vet visit: not \"something's wrong,\" just \"here's what I've actually noticed, with real numbers behind it.\"" }
];

function buildWhatToTrackHtml(dog) {
  const dogName = escapeHtml(dog.dog_name);
  const sub = (s) => s.replace(/\{dog\}/g, dogName);
  const sectionsHtml = WHAT_TO_TRACK_SECTIONS.map(section => `
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">${section.heading}</h3>
    <p style="margin: 0; font-size: 14px; color: #2C2C2C; line-height: 1.6;">${sub(section.body)}</p>`).join('');
  return `
    <p style="font-size: 14px; color: #2C2C2C; line-height: 1.6; margin: 0 0 12px 0;">${sub("Every week, we ask a few quick questions about {dog}. Here's what those questions actually track, and why they matter for senior dogs specifically.")}</p>
    ${sectionsHtml}`;
}

// ---- Document 3: Signs Worth Tracking ----
const SIGNS_WORTH_TRACKING_SECTIONS = [
  { heading: 'Mobility & Movement', items: [
    "Taking longer to get up from lying down",
    "Hesitating or slowing down on stairs",
    "A shorter or slower pace on walks than usual",
    "Stiffness after resting",
    "Any change in how they sit, jump, or lie down"
  ]},
  { heading: 'Energy', items: [
    "Seeming more tired, or less interested in play",
    "Sleeping more during the day",
    "Slower to greet you or respond to familiar cues"
  ]},
  { heading: 'Appetite', items: [
    "Eating less, or taking longer to finish meals",
    "Less interest in treats or favorite foods",
    "Any change in drinking habits"
  ]},
  { heading: 'Cognitive & Behavior', items: [
    "Confusion in familiar spaces",
    "Changes in sleep-wake patterns — restless at night, sleeping more during the day",
    "New anxiety, clinginess, or withdrawal",
    "Trouble recognizing familiar people, places, or routines"
  ]}
];

function buildSignsWorthTrackingDocHtml(dog) {
  const dogName = escapeHtml(dog.dog_name);
  const sub = (s) => s.replace(/\{dog\}/g, dogName);
  const sectionsHtml = SIGNS_WORTH_TRACKING_SECTIONS.map(section => `
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">${section.heading}</h3>
    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #2C2C2C; line-height: 1.7;">
      ${section.items.map(item => `<li>${item}</li>`).join('')}
    </ul>`).join('');
  return `
    <p style="font-size: 14px; color: #2C2C2C; line-height: 1.6; margin: 0 0 12px 0;">${sub("Small changes can say a lot. Here are specific things worth noticing in {dog}'s day-to-day — not warning signs, just the kinds of details that are easy to miss in the moment and useful to have a record of over time.")}</p>
    ${sectionsHtml}
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">A note on how to use this</h3>
    <p style="margin: 0; font-size: 14px; color: #2C2C2C; line-height: 1.6;">A single instance of any of these isn't necessarily a pattern on its own. What's useful is noticing if something repeats or continues over time. That's exactly what your weekly check-ins are for: turning "I think this has been happening for a while" into an actual record you can look back on, and share with your vet if it's ever useful.</p>`;
}

// ---- Document 4: Pet-Proofing Your Home ----
const PET_PROOFING_SECTIONS = [
  { heading: 'Around the House', items: [
    "Trip hazards",
    "Secure cords and small objects",
    "Blocking unsafe areas (stairs, pools)",
    "Pet-safe plants",
    "Secure trash and cabinets"
  ]},
  { heading: 'Mealtime & Water', items: [
    "Accessible bowls",
    "Fresh water in multiple spots"
  ]},
  { heading: 'Comfort & Rest', items: [
    "A dedicated safe/quiet space",
    "Appropriate bedding"
  ]},
  { heading: 'Getting Around', items: [
    "Non-slip surfaces where floors get slippery",
    "Secure fencing/gates"
  ]},
  { heading: 'General Safety', items: [
    "Secure hazardous substances (cleaning products, medications, certain foods)",
    "Keep small objects out of reach"
  ]}
];

const SENIOR_PET_PROOFING_ITEMS = [
  "Rugs or mats on slippery floors — senior dogs are more prone to slipping",
  "Ramps or steps for beds, couches, and cars",
  "Nightlights for nighttime bathroom trips",
  "Orthopedic or supportive bedding",
  "Being mindful of temperature — senior dogs can be more sensitive to cold or heat",
  "Keeping frequently-used items (water, bed, favorite spot) on one level if stairs are a struggle"
];

// Same computed-live, nothing-stored senior flag the dashboard badge and
// breed guide already use (isSeniorForBreed, defined above) -- never
// stale, no second lookup invented here.
function buildPetProofingHtml(dog) {
  const dogName = escapeHtml(dog.dog_name);
  const sectionsHtml = PET_PROOFING_SECTIONS.map(section => `
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">${section.heading}</h3>
    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #2C2C2C; line-height: 1.7;">
      ${section.items.map(item => `<li>${item}</li>`).join('')}
    </ul>`).join('');

  const isSenior = isSeniorForBreed(dog.age, dog.breed);
  const seniorIntro = isSenior
    ? `${dogName} is currently considered a senior for their breed, based on age and breed size. Here are some extra things many senior dog owners consider:`
    : `As dogs age, many owners find a few extra home adjustments helpful. Worth keeping in mind as ${dogName} gets older:`;

  return `
    ${sectionsHtml}
    <h3 style="font-size: 15px; margin: 18px 0 6px 0; color: #2C2C2C;">Extra Considerations for Senior Dogs</h3>
    <p style="margin: 0 0 8px 0; font-size: 14px; color: #2C2C2C; line-height: 1.6;">${seniorIntro}</p>
    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #2C2C2C; line-height: 1.7;">
      ${SENIOR_PET_PROOFING_ITEMS.map(item => `<li>${item}</li>`).join('')}
    </ul>`;
}

// One-line descriptions shared verbatim between the public
// pet-health-library.html cards and the dashboard's document-library menu
// rows below, so the two surfaces can't drift on wording.
const DOCUMENT_LIBRARY_ITEMS = [
  { docId: 'vet-visit-guide', title: 'Vet Visit Guide', description: "Questions to help you prepare for your dog's next vet visit, organized by topic." },
  { docId: 'what-to-track', title: 'What to Track and Why', description: 'What each weekly check-in question actually tracks, and why it matters.' },
  { docId: 'signs-worth-tracking', title: 'Signs Worth Tracking', description: 'Specific day-to-day details worth noticing in your dog, organized by category.' },
  { docId: 'pet-proofing', title: 'Pet-Proofing Your Home', description: 'General home-safety basics for any dog, plus extra considerations if yours is a senior.' }
];

// Assembles all 4 hidden document panes for one dog, in the order they
// appear in the dashboard's document-library menu.
function buildDocumentLibraryPanesHtml(dog) {
  const dogName = escapeHtml(dog.dog_name);
  return [
    buildDocumentPane('vet-visit-guide', `Companion Commons — ${dogName}'s Vet Visit Guide`, buildVetVisitGuideHtml(dog)),
    buildDocumentPane('what-to-track', `${dogName}'s Guide: What to Track and Why`, buildWhatToTrackHtml(dog)),
    buildDocumentPane('signs-worth-tracking', `${dogName}'s Guide: Signs Worth Tracking`, buildSignsWorthTrackingDocHtml(dog)),
    buildDocumentPane('pet-proofing', `${dogName}'s Guide: Pet-Proofing Your Home`, buildPetProofingHtml(dog))
  ].join('');
}

// Extracted from a private closure inside /dashboard/:dog_id (STEP P11
// Stage 3) so /breed-guide/:dog_id can call the same real implementation
// once Stage 4 needs it, instead of a second hand-copied version that
// could silently drift out of sync. Takes hasAnyCheckins explicitly
// instead of reaching into a route's own `checkins` array via closure —
// the dashboard route below passes checkins.length > 0 for this, exactly
// preserving its original behavior.
function describeJourneyTrend(label, baseline, latest, hasAnyCheckins) {
  if (baseline == null && latest == null) {
    return `${label}: not enough data yet`;
  }
  if (baseline == null || latest == null || !hasAnyCheckins) {
    return `${label}: ${latest ?? baseline}/10 (baseline only — no check-ins yet)`;
  }
  // Rounded — baseline/latest can be fractional composite scores
  // (mobility/cognitive), and subtracting two already-rounded
  // NUMERIC(3,1) values can leave raw float noise (e.g.
  // 0.30000000000000004) that used to print verbatim here.
  const diff = roundToOneDecimal(latest - baseline);
  // STEP P10: wording NOT changed here — "up"/"down" already describe the
  // raw number's literal movement, not a good/bad judgment (no
  // "improved"/"declined" language exists in this function), so it stays
  // accurate under the new scale exactly as written.
  if (diff > 0) return `${label}: ${baseline}/10 → ${latest}/10 (up ${diff} since baseline)`;
  if (diff < 0) return `${label}: ${baseline}/10 → ${latest}/10 (down ${Math.abs(diff)} since baseline)`;
  return `${label}: ${baseline}/10 → ${latest}/10 (steady since baseline)`;
}

// Weight-specific variant — "lb" instead of "/10", neutral up/down/steady
// phrasing (no "improved"/"declined" — weight direction isn't inherently
// good or bad the way the score metrics are). Already took no closure
// variables beyond its own params, so this extraction is a clean move
// with no signature change.
function describeWeightJourneyTrend(baseline, latest) {
  if (baseline == null && latest == null) return 'Weight: not enough data yet';
  if (baseline == null || latest == null) return `Weight: ${latest ?? baseline} lb (baseline only — no check-in weight yet)`;
  const diff = latest - baseline;
  if (diff > 0) return `Weight: ${baseline} lb → ${latest} lb (up ${diff} lb since baseline)`;
  if (diff < 0) return `Weight: ${baseline} lb → ${latest} lb (down ${Math.abs(diff)} lb since baseline)`;
  return `Weight: ${baseline} lb → ${latest} lb (steady since baseline)`;
}

// Templated (NOT AI/LLM-generated) neutral written health summary, shared
// by the main dashboard and the Journey Summary report. Deterministic
// server-side logic plugging real calculated numbers into pre-written
// sentence templates -- same non-diagnostic register as the peer-comparison
// card's "About the same as the community average" line. Never uses
// evaluative/interpretive language ("improved", "declined", "concerning")
// -- only neutral descriptors ("changed from X to Y", "stayed at X").
//
// Returns an ARRAY of paragraph strings (1 paragraph for the baseline-only
// and single-check-in cases, up to 3 for the full week-over-week +
// since-baseline + encouragement case) -- callers wrap each in their own
// <p> so dashboard vs. report can style them independently, matching how
// this file's other describe*() helpers stay presentation-agnostic.
//
// variant: 'dashboard' (full -- week-over-week + since-baseline + an
// encouragement line) or 'report' (Journey Summary -- since-baseline only,
// no encouragement line, since this gets printed/shared with a vet rather
// than shown as an in-app retention nudge).
function buildHealthSummary(dog, checkins, variant) {
  const dogName = escapeHtml(dog.dog_name);

  // Oxford-comma joiner -- 1 item as-is, 2 items "A and B", 3+ items
  // "A, B, ..., and Z". Kept generic (not hardcoded to 4 items) so the
  // sentence reads naturally regardless of which domains changed vs.
  // stayed the same on any given call.
  function joinClauses(clauses) {
    if (clauses.length === 1) return clauses[0];
    if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
    return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
  }

  // Diff-based (not `===`) for the same reason describeTrendForGlance and
  // describeJourneyTrend already are -- Supabase can return NUMERIC
  // columns as strings, and composite scores can carry float noise (e.g.
  // 0.30000000000000004), either of which would make a direct `===`
  // between prev/current falsely report "changed" for two numerically
  // identical values.
  function describeDomainClause(label, prev, current) {
    const diff = roundToOneDecimal(Number(current) - Number(prev));
    if (diff === 0) return `${label} has stayed at ${current}/10`;
    return `${label} changed from ${prev}/10 to ${current}/10`;
  }

  if (checkins.length === 0) {
    const baselineClauses = [
      `mobility ${dog.baseline_mobility_score}/10`,
      `energy ${dog.baseline_energy_score}/10`,
      `appetite ${dog.baseline_appetite_score}/10`,
      `cognitive ${dog.baseline_cognitive_score}/10`
    ];
    return [`${dogName}'s baseline: ${baselineClauses.join(', ')}. Complete your first check-in to start seeing trends.`];
  }

  const latest = checkins[checkins.length - 1];
  const previous = checkins.length > 1 ? checkins[checkins.length - 2] : null;

  // "Most recently reported" cognitive value, not strictly "this week's" --
  // cognitive is only asked every 4th week, so this can legitimately be a
  // few weeks old. Reuses the exact lookup pattern already used elsewhere
  // in this file (dashboard/breed-guide chapters) rather than a new one;
  // falls back to the baseline cognitive score when no post-baseline
  // cognitive check-in has ever been recorded yet.
  const latestCognitiveCheckin = [...checkins].reverse().find(c => c.cognitive_score != null);
  const mostRecentCognitive = latestCognitiveCheckin?.cognitive_score ?? dog.baseline_cognitive_score;

  const sinceBaselineClauses = [
    describeDomainClause('mobility', dog.baseline_mobility_score, latest.mobility_score),
    describeDomainClause('energy', dog.baseline_energy_score, latest.energy_score),
    describeDomainClause('appetite', dog.baseline_appetite_score, latest.appetite_score),
    describeDomainClause('cognitive', dog.baseline_cognitive_score, mostRecentCognitive)
  ];
  const sinceBaselineSentence = `Since ${dogName}'s baseline check-in: ${joinClauses(sinceBaselineClauses)}.`;

  if (variant === 'report') {
    return [sinceBaselineSentence];
  }

  const encouragement = 'Keep checking in to build a fuller picture of trends over time.';

  // Exactly one check-in -- no real week-over-week comparison exists yet,
  // so only the since-baseline sentence renders (as one paragraph with the
  // encouragement line, not a separate one -- matches the single-paragraph
  // shape of this case vs. the 3-paragraph shape below).
  if (!previous) {
    return [`${sinceBaselineSentence} ${encouragement}`];
  }

  // Mobility/energy/appetite are required every week, so `previous`/`latest`
  // always have real values for them. Cognitive is the one domain that can
  // genuinely have no data this week (4-week cadence) -- three-way branch:
  // not asked this week, asked this week but no real prior week to diff
  // against (the common case, since the immediately-prior single week is
  // almost never also a cadence week), or a real week-over-week diff in
  // the rare case both weeks happen to have cognitive data.
  let cognitiveWeekClause;
  if (latest.cognitive_score == null) {
    cognitiveWeekClause = 'cognitive had no data reported this week';
  } else if (previous.cognitive_score == null) {
    cognitiveWeekClause = `cognitive was reported at ${latest.cognitive_score}/10 this week`;
  } else {
    cognitiveWeekClause = describeDomainClause('cognitive', previous.cognitive_score, latest.cognitive_score);
  }

  const weekOverWeekClauses = [
    describeDomainClause('mobility', previous.mobility_score, latest.mobility_score),
    describeDomainClause('energy', previous.energy_score, latest.energy_score),
    describeDomainClause('appetite', previous.appetite_score, latest.appetite_score),
    cognitiveWeekClause
  ];
  const weekOverWeekSentence = `Compared to last week: ${joinClauses(weekOverWeekClauses)}.`;

  return [weekOverWeekSentence, sinceBaselineSentence, encouragement];
}

// ============================================
// Post-week-12 display + framing (retention discussion, Aug 24). Nothing
// in the app ever gated or ended at week 12 — it was always just the
// originally-designed check-in cadence length — but every "Week X of 12"
// label kept hardcoding that framing even once a dog logged past it, and
// streaks/milestones went silent past week 12 with nothing telling anyone.
// ============================================

// Shared by the dashboard header, Journey Summary header, and breed guide
// subtitle — all three call this instead of hand-rolling their own
// weekNumber > 12 check, so the three surfaces can't drift on wording.
// Each surface still passes its own existing week-number source in (no new
// calculation introduced) — only the label text is shared.
function formatProgramWeekLabel(weekNumber) {
  return weekNumber > 12
    ? `Week ${weekNumber} — 12-week program complete`
    : `Week ${weekNumber} of 12`;
}

// Shared "keep going" framing, used by both the breed guide's 12-Week
// Milestone chapter and the dashboard's own one-time week-13 banner below,
// so the two surfaces read as one consistent message instead of two
// independently-worded claims. Directionally true, not a fabricated
// statistic — deliberately no specific percentage.
const PROGRAM_CONTINUATION_NOTE = 'Most owners keep logging well past this point — the habit tends to stick once it becomes part of the week, and the picture only gets richer with more real data.';

// The exact calendar week the original 12-week program transitions into
// "past program" (week 12 becoming week 13). Matched with ===, not >=, same
// exact-week-match pattern as BREED_GUIDE_CHAPTER_WEEKS above, so the
// dashboard banner below fires exactly once instead of showing forever.
const PROGRAM_COMPLETE_WEEK = 13;

app.get('/breed-guide/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;

    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not Found</title></head>
        <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; text-align: center;">
          <h2>❌ Dog Not Found</h2>
          <p>We couldn't find this profile. Please check your link and try again.</p>
        </body>
        </html>
      `);
    }

    // Same week-number calculation used everywhere else — no separate
    // "unlocked" flag stored anywhere, computed live.
    const created = new Date(dog.created_at);
    const now = new Date();
    const currentWeek = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    if (currentWeek < 2) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(dog.dog_name)}'s Breed Guide</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; text-align: center; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          </style>
        </head>
        <body>
          <div class="card">
            <p style="font-size: 48px; margin: 0 0 20px 0;"><i data-lucide="lock"></i></p>
            <h2 style="margin: 0 0 10px 0;">Not unlocked yet</h2>
            <p style="color: #666;">${escapeHtml(dog.dog_name)}'s breed guide unlocks after your Week 2 check-in. Keep logging!</p>
            <a href="/dashboard/${dog_id}" style="display: inline-block; margin-top: 20px; background: #007AFF; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none;">Back to Dashboard</a>
          </div>
          <script src="https://unpkg.com/lucide@1.33.0"></script>
          <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
        </body>
        </html>
      `);
    }

    const guide = getBreedGuide(dog.breed);

    // Content-expansion fix: when the resolved guide is genuinely the
    // generic fallback -- checked by reference, not by re-deriving the
    // match -- the page should show the dog's own real typed breed as the
    // name, not GENERIC_BREED_GUIDE's placeholder displayName ("Senior
    // Dogs"). Only the name label changes; the rest of the generic content
    // (History/Temperament/Senior Patterns/Exercise) stays exactly as
    // GENERIC_BREED_GUIDE wrote it. Falls back to "Senior Dogs" only in the
    // genuine edge case of no breed typed at all (nothing real to show).
    const displayBreedName = guide === GENERIC_BREED_GUIDE
      ? (escapeHtml(dog.breed) || 'Senior Dogs')
      : guide.displayName;

    // Show the dog's own current score neutrally — deliberately NOT compared
    // to other dogs, breed averages, or percentiles (see note at top of section).
    // No .limit(1) here (unlike before) — weight isn't recorded every week,
    // so the full history is fetched to find the latest entry that has one.
    //
    // STEP P11 Stage 4: widened from 'mobility_score, weight_lbs' to '*'
    // (matching /dashboard/:dog_id's own select('*') on this table) so this
    // one query can also feed the week 8/12 chapters' Energy/Appetite/
    // Cognitive trend lines below, instead of adding a second narrower
    // query alongside this one. Kept this route's existing newest-first
    // order (unlike the dashboard's oldest-first) since currentMobility/
    // currentWeight below already correctly depend on index 0 being most
    // recent — no reason to touch that working logic just to match the
    // dashboard's own ordering convention.
    const { data: latestCheckins } = await supabase
      .from('mobility_checkins')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });
    const currentMobility = latestCheckins?.[0]?.mobility_score ?? dog.baseline_mobility_score;

    // Senior-by-breed-size flag — live, nothing stored (see helpers above getBreedGuide).
    const isSenior = isSeniorForBreed(dog.age, dog.breed);
    const seniorSectionHeading = isSenior ? 'Senior Health Patterns' : 'Looking Ahead';
    const seniorSectionCopy = isSenior ? guide.seniorPatterns : getNotYetSeniorCopy(dog.breed);
    const seniorSectionBlock = currentWeek >= 4
      ? `<h2>${seniorSectionHeading}</h2>\n          <p>${seniorSectionCopy}</p>`
      : buildLockedChapterTeaser(seniorSectionHeading, 4);

    // Most recent weight — a check-in weight if one exists yet, else the
    // baseline weight from signup. Compared non-diagnostically against the
    // breed's typical range; null (and hidden entirely) for mixed breed /
    // the generic fallback, which have no real range to compare against.
    const latestWeightCheckin = latestCheckins?.find(c => c.weight_lbs != null);
    const currentWeight = latestWeightCheckin?.weight_lbs ?? dog.weight_lbs ?? null;
    const weightComparisonText = compareWeightToBreedRange(currentWeight, guide);

    // STEP P11 Stage 4 — weeks 8/12 chapters (Decision 3). Sourced exactly
    // how the dashboard sources these same four lines: latestCheckins here
    // is already newest-first (see the widened query above), so "most
    // recent" is index 0 and finding the latest cognitive entry is a plain
    // .find() — no .reverse() needed the way the dashboard's oldest-first
    // `checkins` array requires. Cognitive is only collected every 4th
    // week, so this can legitimately be null on a dog that hasn't hit a
    // cognitive-cadence week yet; describeJourneyTrend already handles a
    // null baseline/latest pair correctly ("not enough data yet").
    const hasAnyCheckins = latestCheckins.length > 0;
    const currentEnergyScore = hasAnyCheckins ? latestCheckins[0].energy_score : dog.baseline_energy_score;
    const currentAppetiteScore = hasAnyCheckins ? latestCheckins[0].appetite_score : dog.baseline_appetite_score;
    const latestCognitiveCheckin = latestCheckins.find(c => c.cognitive_score != null);
    const chapterTrendLines = [
      describeJourneyTrend('Mobility', dog.baseline_mobility_score, hasAnyCheckins ? currentMobility : null, hasAnyCheckins),
      describeJourneyTrend('Energy', dog.baseline_energy_score, hasAnyCheckins ? currentEnergyScore : null, hasAnyCheckins),
      describeJourneyTrend('Appetite', dog.baseline_appetite_score, hasAnyCheckins ? currentAppetiteScore : null, hasAnyCheckins),
      describeJourneyTrend('Cognitive/Behavior', dog.baseline_cognitive_score, latestCognitiveCheckin?.cognitive_score ?? null, hasAnyCheckins),
      // NOT currentWeight directly — that already falls back to
      // dog.weight_lbs (baseline) when no check-in has recorded a weight,
      // for the separate dog-snapshot display below. Feeding that same
      // fallback value in here as "latest" would compare baseline against
      // itself and falsely report "steady" during the baseline-only
      // period — the exact bug already found and fixed once in this
      // project (Aug 21, dashboard's "held steady" false-trend bug). Only
      // pass a real value when a real check-in actually recorded one.
      describeWeightJourneyTrend(dog.weight_lbs, latestWeightCheckin ? currentWeight : null)
    ];
    const chapterStreak = await calculateCurrentStreak(dog_id);

    const journeyChapterBlock = currentWeek >= 8
      ? buildJourneyChapter(escapeHtml(dog.dog_name), chapterTrendLines, chapterStreak)
      : buildLockedChapterTeaser("Your Dog's Journey", 8);
    const milestoneChapterBlock = currentWeek >= 12
      ? buildMilestoneChapter(escapeHtml(dog.dog_name), chapterTrendLines, chapterStreak)
      : buildLockedChapterTeaser('12-Week Milestone', 12);

    // At-a-Glance strip -- skipped entirely for Mixed Breed and the generic
    // fallback (neither has an atAGlance field at all, by design, so this
    // condition alone naturally excludes both without a separate check).
    const atAGlanceBlock = guide.atAGlance ? `
          <div class="at-a-glance">
            <div class="at-a-glance-row"><span class="at-a-glance-label">Energy Level</span><span class="at-a-glance-value">${guide.atAGlance.energyLevel}</span></div>
            <div class="at-a-glance-row"><span class="at-a-glance-label">Grooming</span><span class="at-a-glance-value">${guide.atAGlance.grooming}</span></div>
            <div class="at-a-glance-row"><span class="at-a-glance-label">Average Lifespan</span><span class="at-a-glance-value">${guide.atAGlance.averageLifespan}</span></div>
          </div>` : '';

    const contentDisclaimerText = BREED_CONTENT_DISCLAIMER_TEMPLATE.replace('[dog name]', escapeHtml(dog.dog_name));

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(dog.dog_name)}'s ${displayBreedName} Guide</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 650px; margin: 40px auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }
          .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .dog-photo { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin: 0 0 16px 0; display: block; }
          .dog-photo-placeholder { width: 80px; height: 80px; border-radius: 50%; background: #FFF8E7; display: flex; align-items: center; justify-content: center; font-size: 36px; margin: 0 0 16px 0; }
          h1 { font-size: 24px; margin: 0 0 4px 0; }
          .pronunciation { color: #999; font-size: 15px; font-weight: 400; font-style: italic; }
          .subtitle { color: #999; font-size: 14px; margin: 0 0 30px 0; }
          .content-disclaimer { color: #888; font-size: 13px; font-style: italic; line-height: 1.5; margin: 0 0 30px 0; }
          h2 { font-size: 16px; color: #A89968; text-transform: uppercase; letter-spacing: 0.5px; margin: 30px 0 10px 0; }
          .dog-snapshot { background: #FFF8E7; border-radius: 8px; padding: 16px 20px; margin: 30px 0; }
          .at-a-glance { background: #FFF8E7; border-radius: 8px; padding: 4px 20px; margin: 20px 0 30px 0; }
          .at-a-glance-row { display: flex; justify-content: space-between; gap: 20px; padding: 12px 0; font-size: 14px; border-bottom: 1px solid #EEE4CC; }
          .at-a-glance-row:last-child { border-bottom: none; }
          .at-a-glance-label { color: #8A7A4F; font-weight: 600; white-space: nowrap; }
          .at-a-glance-value { text-align: right; }
          .disclaimer { background: #FAFAFA; border: 1px solid #EEE; border-radius: 8px; padding: 20px; margin-top: 30px; font-size: 13px; color: #777; line-height: 1.6; }
          .disclaimer strong { color: #555; }
          .disclaimer a { color: #A89968; }
          .back-link { display: inline-block; margin-top: 30px; color: #007AFF; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="margin: 0 0 20px 0;">${buildBrandLockup({ iconPx: 26, fontPx: 15 })}</div>

          ${dog.photo_url
            ? `<img src="${dog.photo_url}" alt="${escapeHtml(dog.dog_name)}" class="dog-photo" />`
            : `<div class="dog-photo-placeholder"><i data-lucide="paw-print"></i></div>`
          }

          <p style="font-size: 32px; margin: 0 0 10px 0;"><i data-lucide="book-open"></i></p>
          <h1>${displayBreedName}${guide.pronunciation ? ` &nbsp;•&nbsp; <span class="pronunciation">${guide.pronunciation}</span>` : ''}: A Health Journey Guide</h1>
          <p class="subtitle">Unlocked for ${escapeHtml(dog.dog_name)} — ${formatProgramWeekLabel(currentWeek)}${guide.typicalWeight ? ` &nbsp;•&nbsp; Typical weight: ${guide.typicalWeight}` : ''}</p>
          <p class="content-disclaimer">${contentDisclaimerText}</p>
          ${atAGlanceBlock}

          <h2>History</h2>
          <p>${guide.history}</p>

          <h2>Temperament</h2>
          <p>${guide.temperament}</p>

          <h2>Exercise & Activity</h2>
          <p>${guide.exercise}</p>

          ${seniorSectionBlock}

          ${journeyChapterBlock}

          ${milestoneChapterBlock}

          <div class="dog-snapshot">
            <strong>${escapeHtml(dog.dog_name)}'s current mobility:</strong> ${currentMobility}/10
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #888;">This is just ${escapeHtml(dog.dog_name)}'s own number — not a comparison to other dogs. Keep logging to build a clearer picture over time.</p>
          </div>

          ${weightComparisonText ? `
          <div class="dog-snapshot" style="margin-top: 12px;">
            <strong>${escapeHtml(dog.dog_name)}'s current weight:</strong> ${currentWeight} lb
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #888;">This is ${weightComparisonText}.</p>
          </div>
          ` : ''}

          <div class="disclaimer">
            <p style="margin: 0;">Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.</p>
            <p style="margin: 12px 0 0 0;">See our <a href="/terms.html">Terms of Service</a> and <a href="/privacy.html">Privacy Policy</a> for more.</p>
          </div>

          <a href="/dashboard/${dog_id}" class="back-link">← Back to Dashboard</a>
        </div>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error loading breed guide:', error);
    res.status(500).send('Error loading breed guide');
  }
});

// ============================================
// STEP: MID-WEEK NOTES (Aug 19)
// Deliberately NOT gated by the 7-day check-in cycle — owners can add an
// observation any time. This is what gives people a real reason to open
// the dashboard between formal weekly updates.
// ============================================
app.post('/api/notes/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;
    const { note_text } = req.body;

    if (!note_text || !note_text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const { error } = await supabase
      .from('dog_notes')
      .insert({ dog_id, note_text: note_text.trim() });

    if (error) throw error;

    // Export to Google Sheets (Notes tab) — real-time, same as signups and
    // check-ins. Needs the dog's name, which the notes table itself doesn't
    // store, so fetch it here.
    const { data: dogForNote } = await supabase
      .from('senior_dogs')
      .select('dog_name')
      .eq('id', dog_id)
      .single();

    await appendRowToSheet('Notes', [
      new Date().toISOString(),
      dog_id,
      dogForNote?.dog_name || '',
      note_text.trim()
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// ============================================
// MEDICATIONS -- add one for an EXISTING dog, any time (not just baseline
// signup, which stages through /api/send-magic-link + /verify or inserts
// directly via /api/add-dog instead). Reuses the exact same validation
// (cleanMedicationEntry) as both signup paths -- one implementation.
// ============================================
app.post('/api/medications', async (req, res) => {
  try {
    const { dog_id, category, condition_treated, condition_source, date_started } = req.body;

    if (!dog_id) {
      return res.status(400).json({ success: false, error: 'Missing required field: dog_id' });
    }

    const clean = cleanMedicationEntry({ category, condition_treated, condition_source, date_started });
    if (!clean) {
      return res.status(400).json({ success: false, error: 'Missing or invalid medication fields' });
    }

    // Confirm the dog is real before creating anything against it, same
    // pattern as /api/add-dog's owner check.
    const { data: dog, error: dogLookupError } = await supabase
      .from('senior_dogs')
      .select('id')
      .eq('id', dog_id)
      .maybeSingle();
    if (dogLookupError || !dog) {
      return res.status(404).json({ success: false, error: 'Dog not found' });
    }

    const { data: newMed, error: insertError } = await supabase
      .from('medications')
      .insert({ dog_id, ...clean })
      .select()
      .single();

    if (insertError) {
      console.error(`❌ Error adding medication for dog ${dog_id}:`, insertError.message);
      return res.status(500).json({ success: false, error: 'Failed to add medication' });
    }

    res.json({ success: true, medication: newMed });
  } catch (error) {
    console.error('Error in POST /api/medications:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Marks one medication stopped -- sets date_stopped, does NOT delete the
// row (historical weekly updates stay attached to it). Shares the exact
// same stopMedication() helper the weekly-update flow's "stopped" chip
// uses, so there's one real implementation of what "stopping a
// medication" does, not two that could drift.
app.post('/api/medications/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: medication, error: lookupError } = await supabase
      .from('medications')
      .select('id, date_stopped')
      .eq('id', id)
      .maybeSingle();

    if (lookupError || !medication) {
      return res.status(404).json({ success: false, error: 'Medication not found' });
    }
    if (medication.date_stopped) {
      // Idempotent -- already stopped, not an error.
      return res.json({ success: true, alreadyStopped: true });
    }

    const stopped = await stopMedication(id);
    if (!stopped) {
      return res.status(500).json({ success: false, error: 'Failed to stop medication' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in POST /api/medications/:id/stop:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/dashboard/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;
    console.log(`📊 Dashboard request for dog: ${dog_id}`);

    // Fetch dog info
    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      console.error('Dog not found:', dogError);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dog Not Found</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            h2 { color: #d32f2f; margin-bottom: 10px; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>❌ Dog Not Found</h2>
            <p>We couldn't find this dog's profile (ID: ${dog_id}). Please check your link and try again.</p>
            <p style="margin-top: 16px;"><a href="/find-my-dashboard.html" style="color: #007AFF;">Lost your link? Find your dashboard here.</a></p>
          </div>
        </body>
        </html>
      `);
    }

    // ============================================
    // STAGE 5 (multi-dog owner project): additive-only owner session.
    // LOCKED DECISION — this block must never gate or change anything
    // above it. The dog fetch/render above is unconditional and stays
    // exactly as it's always worked, so a shared dashboard/Journey Summary
    // link keeps working with zero login for anyone who opens it (a vet, a
    // family member) — that's already-shipped behavior this must not
    // regress. This block only ever ADDS a dog switcher on top, and only
    // when a session cookie exists AND belongs to the owner of THIS dog —
    // a valid session for a *different* owner (e.g. a vet's own session,
    // opened on a client's shared link) must render identically to no
    // session at all, not leak that other owner's dog list here.
    // ============================================
    let dogSwitcherHtml = '';
    const dashboardCookies = parseCookies(req);
    const sessionOwnerId = dashboardCookies[OWNER_SESSION_COOKIE];
    if (sessionOwnerId && dog.owner_id && sessionOwnerId === dog.owner_id) {
      // Sliding renewal: any valid, matching use extends the session
      // another 90 days, rather than counting down from a fixed grant
      // time. An owner who keeps visiting effectively never sees the
      // switcher disappear; one who doesn't simply stops getting the
      // convenience — never a functional loss either way.
      setOwnerSessionCookie(res, sessionOwnerId);

      const { data: ownersDogs } = await supabase
        .from('senior_dogs')
        .select('id, dog_name, photo_url')
        .eq('owner_id', sessionOwnerId)
        .order('created_at', { ascending: true });

      if (ownersDogs && ownersDogs.length > 1) {
        dogSwitcherHtml = buildDogSwitcherHtml(ownersDogs, dog_id);
      }
    }

    // Fetch all check-ins for this dog, ordered by date
    const { data: checkins, error: checkinsError } = await supabase
      .from('mobility_checkins')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: true });

    if (checkinsError) {
      console.error('Error fetching checkins:', checkinsError);
      throw checkinsError;
    }

    // Templated neutral health summary (see buildHealthSummary above) --
    // computed once here from the same `checkins` array both the dashboard
    // and the Journey Summary modal (rendered later in this same route
    // response) already read from, rather than querying twice.
    const dashboardHealthSummary = buildHealthSummary(dog, checkins, 'dashboard');
    const reportHealthSummary = buildHealthSummary(dog, checkins, 'report');

    // Document Library -- 4 personalized printable documents (see
    // buildDocumentLibraryPanesHtml above), pre-rendered here the same way
    // the Journey Summary content above is: real dog data substituted
    // server-side, hidden in the DOM until a menu row reveals one.
    const documentLibraryPanesHtml = buildDocumentLibraryPanesHtml(dog);

    // STEP 27D: Fetch any active health alerts (last 14 days) for the banner.
    // Most recent first — if multiple metrics triggered alerts, show the newest.
    const fourteenDaysAgoForDisplay = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: activeAlerts } = await supabase
      .from('health_alerts')
      .select('*')
      .eq('dog_id', dog_id)
      .gte('created_at', fourteenDaysAgoForDisplay)
      .order('created_at', { ascending: false })
      .limit(1);

    const activeAlert = activeAlerts?.[0] || null;

    // STEP: Fetch mid-week notes, most recent first
    const { data: dogNotes } = await supabase
      .from('dog_notes')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });

    // Note (Aug 19): dashboard no longer shows a separate placeholder page for
    // zero check-ins. It always renders the real dashboard, using the dog's
    // baseline score as the starting data point until a real check-in exists.
    // This fixes a real UX bug: the old placeholder's only CTA was "Record
    // First Check-In", which new users clicked thinking it was how you access
    // the dashboard at all — conflating viewing the dashboard with submitting
    // a weekly update.

    // Calculate metrics — falls back to baseline score when no check-in
    // exists yet, so the dashboard always has a real starting data point.
    const currentScore = checkins.length > 0
      ? checkins[checkins.length - 1].mobility_score
      : dog.baseline_mobility_score;
    // previous falls back to baseline only when exactly 1 real check-in exists
    // (comparing it against baseline is meaningful) — with 0 check-ins there's
    // no real prior data point at all, so this stays null rather than
    // defaulting to the same baseline value as currentScore, which used to
    // make describeTrendForGlance see two identical numbers and falsely
    // report "held steady" during the baseline-only period.
    const previousScore = checkins.length > 1
      ? checkins[checkins.length - 2].mobility_score
      : checkins.length === 1 ? dog.baseline_mobility_score : null;

    const scoreDiff = currentScore - previousScore;
    const trend = scoreDiff > 0 ? 'up' : scoreDiff < 0 ? 'down' : 'flat';
    const trendEmoji = trend === 'up' ? '📈' : trend === 'down' ? '📉' : '➡️';
    const trendText = checkins.length === 0
      ? 'Baseline'
      : (trend === 'up' ? 'Improving' : trend === 'down' ? 'Declining' : 'Stable');
    const trendColor = trend === 'up' ? '#4CAF50' : trend === 'down' ? '#FF6B6B' : '#FFC107';

    // STEP: Real "This Week at a Glance" data — this section used to be
    // hardcoded static text ("has been more difficult for two weeks") shown
    // identically on every dog's dashboard regardless of their real data.
    // That's a real accuracy problem worth fixing properly, not just
    // cosmetically — these lines now reflect actual score changes.
    const currentEnergyScore = checkins.length > 0
      ? checkins[checkins.length - 1].energy_score
      : dog.baseline_energy_score;
    const previousEnergyScore = checkins.length > 1
      ? checkins[checkins.length - 2].energy_score
      : checkins.length === 1 ? dog.baseline_energy_score : null;
    const currentAppetiteScore = checkins.length > 0
      ? checkins[checkins.length - 1].appetite_score
      : dog.baseline_appetite_score;
    const previousAppetiteScore = checkins.length > 1
      ? checkins[checkins.length - 2].appetite_score
      : checkins.length === 1 ? dog.baseline_appetite_score : null;

    // Weight isn't recorded every week (only on the every-4th-week check-in,
    // same trigger as cognitive/behavior), so unlike the 3 scores above this
    // filters down to just the check-ins that actually have a weight first.
    const weightCheckins = checkins.filter(c => c.weight_lbs != null);
    const currentWeightValue = weightCheckins.length > 0
      ? weightCheckins[weightCheckins.length - 1].weight_lbs
      : dog.weight_lbs;
    const previousWeightValue = weightCheckins.length > 1
      ? weightCheckins[weightCheckins.length - 2].weight_lbs
      : weightCheckins.length === 1 ? dog.weight_lbs : null;

    function describeTrendForGlance(current, previous) {
      // previous is only ever null now during the baseline-only period (see
      // the null fallback above) — current is never null (baseline scores
      // are required at signup), so this branch is effectively "no real
      // check-in yet," not a generic missing-data case.
      if (current == null || previous == null) return "Baseline recorded — first weekly update will show your dog's trend";
      // Rounded immediately, before the sign check — current/previous can be
      // fractional composite scores (mobility), and subtracting two already-
      // rounded NUMERIC(3,1) values can leave raw float noise (e.g.
      // 0.30000000000000004). Rounding first also guards the sign check
      // itself: an unrounded near-zero diff from float noise around a true
      // 0.0 could otherwise flip "held steady" into a false improved/declined.
      const diff = roundToOneDecimal(current - previous);
      // STEP P10: higher = more concerning now, so a score DECREASE is the
      // improvement — flipped from the old scale. diff is already negative
      // when the score fell, so it prints correctly as e.g. "improved (-2)".
      if (diff < 0) return `improved (${diff})`;
      if (diff > 0) return `declined (+${diff})`;
      return 'held steady';
    }

    // Separate from describeTrendForGlance above on purpose: weight going up
    // or down isn't inherently "improved" or "declined" the way a higher
    // mobility/energy/appetite score is, so this uses neutral up/down/steady
    // language instead — no health judgment either way.
    function describeWeightTrendForGlance(current, previous) {
      if (current == null || previous == null) return "Baseline recorded — first weekly update will show your dog's trend";
      const diff = current - previous;
      if (diff > 0) return `up ${diff} lb since last recorded`;
      if (diff < 0) return `down ${Math.abs(diff)} lb since last recorded`;
      return 'steady since last recorded';
    }

    // Calculate streak (consecutive weeks with check-ins) — 0 when there
    // are no check-ins yet, guarded before touching the array at all so it
    // can't crash on an empty list.
    let streak = 0;
    if (checkins.length > 0) {
      const sortedByWeek = [...checkins].sort((a, b) => b.week_number - a.week_number);
      // Same defensive floor as calculateCurrentStreak() — a stray week_number
      // of 0 or less shouldn't make this loop skip entirely.
      const maxWeek = Math.max(1, sortedByWeek[0].week_number);
      for (let i = maxWeek; i >= 1; i--) {
        const hasWeek = checkins.some(c => c.week_number === i);
        if (hasWeek) {
          streak++;
        } else {
          break;
        }
      }
    }

    // Get peer average (latest score per dog, then average)
    const { data: allLatestScores } = await supabase
      .from('mobility_checkins')
      .select('dog_id, mobility_score, created_at')
      .order('created_at', { ascending: false });

    // `in`, not a truthy check — found during Stage 4b review, same bug
    // class as the || vs ?? fixes elsewhere. allLatestScores is ordered
    // newest-first per dog, so the FIRST row seen for a dog_id is meant to
    // win; a truthy check (`!latestPerDog[checkin.dog_id]`) would treat a
    // real mobility_score of 0 (a legitimate, perfectly healthy value on
    // the new 0-10 scale) as "not set yet" and let an OLDER row for that
    // same dog silently overwrite it.
    const latestPerDog = {};
    if (allLatestScores) {
      for (const checkin of allLatestScores) {
        if (!(checkin.dog_id in latestPerDog)) {
          latestPerDog[checkin.dog_id] = checkin.mobility_score;
        }
      }
    }

    const peerScores = Object.values(latestPerDog);
    const peerAverage = peerScores.length > 0
      ? (peerScores.reduce((a, b) => a + b, 0) / peerScores.length).toFixed(1)
      : 0;

    // STEP P10: this comparator is DELIBERATELY left unchanged — not an
    // oversight. Under the OLD scale (higher = better), "count dogs with a
    // lower score than mine, +1" actually gave the WORST dog rank #1
    // (verified with a concrete example during Stage 4 planning — beating
    // more dogs made your rank number go UP, backwards from a normal
    // leaderboard). Under the NEW scale (lower = better), this exact same
    // comparator now counts dogs with a lower (better) score than mine,
    // which correctly gives the BEST dog rank #1. The scale flip fixes this
    // formula for free; flipping the comparator here would have
    // re-introduced the old backwards behavior. See
    // docs/Health_Instrument_Redesign_Build.md Stage 4 spec.
    const dogsWithLowerScores = peerScores.filter(s => s < currentScore).length;
    const rank = dogsWithLowerScores + 1;
    const totalDogs = peerScores.length;

    // Prepare chart data
    // Chart shows just the baseline point when there's no real check-in yet,
    // instead of an empty chart.
    const chartScores = checkins.length > 0
      ? checkins.map(c => c.mobility_score)
      : [dog.baseline_mobility_score];
    const chartEnergyScores = checkins.length > 0
      ? checkins.map(c => c.energy_score)
      : [dog.baseline_energy_score];
    const chartAppetiteScores = checkins.length > 0
      ? checkins.map(c => c.appetite_score)
      : [dog.baseline_appetite_score];
    // Cognitive is only asked every 4th week, so most entries are null here
    // by design — Chart.js's default spanGaps:false leaves a genuine gap
    // rather than interpolating across weeks it wasn't actually measured,
    // which is the honest representation, not a bug to work around.
    const chartCognitiveScores = checkins.length > 0
      ? checkins.map(c => c.cognitive_score)
      : [dog.baseline_cognitive_score];
    // Same null-per-week pattern as chartCognitiveScores — weight is only
    // recorded on cadence weeks. Deliberately uses the SAME chartWeeks
    // x-axis as the main chart (not compressed to only the weeks weight was
    // recorded), so a weight change lines up visually against that same
    // week's mobility/energy movement on the main chart — the actual point
    // of tracking weight for an already-overweight dog.
    const chartWeightScores = checkins.length > 0
      ? checkins.map(c => c.weight_lbs)
      : [dog.weight_lbs];
    const chartWeeks = checkins.length > 0
      ? checkins.map(c => `W${c.week_number}`)
      : ['Baseline'];

    // Latest scores for pre-filling the check-in modal widgets (STEP P1B: Smart
    // Defaults). Falls back to the dog's baseline value, not a hardcoded
    // number, so a dog with no prior weekly check-in still gets a real
    // starting point. `checkins` is select('*'), so item columns are
    // already present on each row.
    const latestCheckinRow = checkins[checkins.length - 1];
    // Cognitive is only asked every 4th week, so the most recent row often
    // has null cognitive_* — find the most recent row that actually HAS
    // cognitive values instead, same pattern as weightCheckins below.
    const latestCognitiveRow = [...checkins].reverse().find(c => c.cognitive_orientation != null);

    const mobilityPrefill = {
      getting_up: latestCheckinRow?.mobility_getting_up ?? dog.baseline_mobility_getting_up ?? null,
      stairs: latestCheckinRow?.mobility_stairs ?? dog.baseline_mobility_stairs ?? null,
      stiffness_after_rest: latestCheckinRow?.mobility_stiffness_after_rest ?? dog.baseline_mobility_stiffness_after_rest ?? null,
      walk_distance: latestCheckinRow?.mobility_walk_distance ?? dog.baseline_mobility_walk_distance ?? null
    };
    const cognitivePrefill = {
      orientation: latestCognitiveRow?.cognitive_orientation ?? dog.baseline_cognitive_orientation ?? null,
      memory: latestCognitiveRow?.cognitive_memory ?? dog.baseline_cognitive_memory ?? null,
      interest: latestCognitiveRow?.cognitive_interest ?? dog.baseline_cognitive_interest ?? null,
      sleep_wake: latestCognitiveRow?.cognitive_sleep_wake ?? dog.baseline_cognitive_sleep_wake ?? null
    };
    const latestEnergyScore = latestCheckinRow?.energy_score ?? dog.baseline_energy_score ?? null;
    const latestAppetiteScore = latestCheckinRow?.appetite_score ?? dog.baseline_appetite_score ?? null;
    // Weight pre-fill uses the same weightCheckins list computed above (not
    // latestCheckinRow), since the most recent check-in overall often won't
    // be the one that actually recorded a weight.
    const latestWeightScore = weightCheckins.length > 0
      ? weightCheckins[weightCheckins.length - 1].weight_lbs
      : (dog.weight_lbs ?? '');

    // Senior-by-breed-size flag — live, nothing stored (see helpers defined
    // near getBreedGuide/BREED_GUIDES above).
    const isSenior = isSeniorForBreed(dog.age, dog.breed);

    // Overweight-by-breed flag, same live/nothing-stored pattern. Reuses
    // currentWeightValue (already resolved above: latest weight-bearing
    // check-in, falling back to dog.weight_lbs) rather than a second
    // lookup. weightDataPointCount counts baseline (always present, weight
    // is required at signup) plus every real check-in that recorded a
    // weight — the weight mini-chart only renders once there are at least
    // 2 of these, the point where a real trend (not just one number) exists.
    const isOverweight = isOverweightForBreed(currentWeightValue, dog.breed);
    const weightDataPointCount = 1 + weightCheckins.length;
    const showWeightChart = isOverweight && weightDataPointCount >= 2;

    // Calculate the actual current week (matches /api/checkin-senior's calculation)
    // so we know whether to show the every-4th-week cognitive/behavior slider.
    const dogCreatedAt = new Date(dog.created_at);
    const dashboardNow = new Date();
    const nextCheckinWeekNumber = Math.max(1, Math.floor((dashboardNow - dogCreatedAt) / (7 * 24 * 60 * 60 * 1000)) + 1);
    const showCognitiveThisWeek = nextCheckinWeekNumber % 4 === 0;
    const activeMedicationsForModal = await getActiveMedicationsForDog(dog_id);

    // STEP: Real "update due" calculation, separate from nextCheckinWeekNumber
    // above (which is used for saving check-ins and the every-4th-week
    // cognitive question). This one drives what the dashboard actually shows
    // as due — baseline (signup) doesn't count as week 1; week 1 only
    // becomes due 7 full days after signup, matching the real weekly cadence.
    const daysSinceSignup = (dashboardNow - dogCreatedAt) / (24 * 60 * 60 * 1000);
    // Defensive floor: without this, a created_at that's marginally in the
    // future relative to server time (clock skew, a TZ-less timestamp
    // misparsed as local time — the same bug class as the original "Week
    // #0" fix) sends daysSinceSignup slightly negative, which floors to -1
    // instead of 0, incorrectly flipping a genuinely-in-baseline dog to
    // "not in baseline" (isInBaselinePeriod checks === 0).
    //
    // weeksSinceSignup is elapsed-time-only and uses a DIFFERENT numbering
    // convention than mostRecentSubmittedWeek/nextCheckinWeekNumber below —
    // it's "how many full weeks since signup" (0-indexed), not "which
    // submission-numbered week are we on" (1-indexed, where week 1 is the
    // baseline-blocked period and week 2 is the first real check-in
    // opportunity). That's a real, systematic off-by-one between the two,
    // not a bug in either individually — weeksSinceSignup is only ever
    // meant to drive baseline-period/due-week detection below, never a
    // user-visible "Week X of 12" label. It used to feed the Journey
    // Summary's own header too, which is exactly what produced the
    // "dashboard says Week 4, Journey Summary says Week 3" bug for the
    // same dog at the same moment — reconciled by pointing the Journey
    // Summary header at mostRecentSubmittedWeek instead, the same source
    // the dashboard's own header and week-dots already use.
    const weeksSinceSignup = Math.max(0, Math.floor(daysSinceSignup / 7)); // 0 during baseline period, 1 from day 7, etc.
    const mostRecentSubmittedWeek = checkins.length > 0
      ? Math.max(...checkins.map(c => c.week_number))
      : 0;
    const isInBaselinePeriod = weeksSinceSignup === 0;
    const daysUntilFirstUpdate = isInBaselinePeriod ? Math.max(1, 7 - Math.floor(daysSinceSignup)) : 0;
    const hasUpdateDue = !isInBaselinePeriod && weeksSinceSignup > mostRecentSubmittedWeek;
    const dueWeekNumber = weeksSinceSignup; // the week number that's actually due right now, if any

    // ============================================
    // JOURNEY SUMMARY — real data, built from what's already loaded above.
    // Purpose (per the button's own copy): help an owner prep for a
    // conversation with a vet, family member, or sitter. Reuses checkins,
    // dogNotes, activeAlert, and dog — no new queries needed.
    //
    // STEP P11 Stage 3: describeJourneyTrend/describeWeightJourneyTrend
    // used to be private closures defined right here — extracted to real
    // top-level functions (see above getBreedGuide) so /breed-guide/:dog_id
    // can call the exact same implementation once Stage 4 needs it,
    // instead of a second hand-copied version. describeJourneyTrend now
    // takes hasAnyCheckins explicitly instead of reaching into this
    // route's own `checkins` via closure.
    // ============================================
    const latestCognitiveCheckin = [...checkins].reverse().find(c => c.cognitive_score != null);
    const journeyTrendLines = [
      describeJourneyTrend('Mobility', dog.baseline_mobility_score, checkins.length > 0 ? currentScore : null, checkins.length > 0),
      describeJourneyTrend('Energy', dog.baseline_energy_score, checkins.length > 0 ? currentEnergyScore : null, checkins.length > 0),
      describeJourneyTrend('Appetite', dog.baseline_appetite_score, checkins.length > 0 ? currentAppetiteScore : null, checkins.length > 0),
      describeJourneyTrend('Cognitive/Behavior', dog.baseline_cognitive_score, latestCognitiveCheckin?.cognitive_score ?? null, checkins.length > 0),
      describeWeightJourneyTrend(dog.weight_lbs, weightCheckins.length > 0 ? currentWeightValue : null)
    ];

    // Weekly table rows, most recent first
    const journeyTableRows = [...checkins]
      .sort((a, b) => b.week_number - a.week_number)
      .map(c => {
        const dateStr = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `<tr>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee;">Week ${c.week_number}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee;">${dateStr}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.mobility_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.energy_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.appetite_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.cognitive_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.weight_lbs != null ? `${c.weight_lbs} lb` : '—'}</td>
        </tr>`;
      }).join('');

    // Notes, most recent first (dogNotes already ordered that way from the query above)
    const journeyNotesHtml = (dogNotes && dogNotes.length > 0)
      ? dogNotes.map(n => {
          const noteDate = new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          return `<div style="padding: 10px 0; border-bottom: 1px solid #eee;">
            <div style="font-size: 12px; color: #888; margin-bottom: 3px;">${noteDate}</div>
            <div style="font-size: 14px; color: #2C2C2C;">${escapeHtml(n.note_text)}</div>
          </div>`;
        }).join('')
      : `<p style="font-size: 14px; color: #888;">No notes logged yet.</p>`;

    // Active alert, if any (reuses the same activeAlert already fetched for the dashboard banner).
    // Shows activeAlert.message alone -- same as the dashboard card. A second,
    // hardcoded "worth mentioning to your vet" line used to be appended here
    // unconditionally, regardless of direction -- redundant for an up-direction
    // alert (whose own message already ends with the vet-mention framing) and
    // an active bug for a down-direction alert (whose message ends with
    // "consider adding a note," never a vet-visit framing), producing a
    // mismatched two-sentence disclaimer. Removed rather than made conditional
    // -- activeAlert.message already carries the correct, direction-specific
    // ending on its own.
    const journeyAlertHtml = activeAlert
      ? `<div style="background: #FFF8E1; border-left: 4px solid #F5A623; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;">
          <p style="margin: 0; font-size: 14px; color: #2C2C2C; font-weight: 500;">⚠️ ${escapeHtml(activeAlert.message) || 'A recent change was flagged for this dog.'}</p>
        </div>`
      : '';

    console.log(`✅ Dashboard loaded for ${dog.dog_name}: score=${currentScore}, trend=${trend}, streak=${streak}, rank=${rank}/${totalDogs}`);

    // Send dashboard HTML with Chart.js visualization
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(dog.dog_name)}'s Dashboard</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F5F1E8;
            min-height: 100vh;
            padding: 20px;
            color: #2C2C2C;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header {
            background: #FAFAF8;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .header h1 { font-size: 28px; margin-bottom: 8px; color: #2C2C2C; font-weight: 600; }
          .header p { font-size: 14px; color: #888; font-weight: 400; }
          .week-progress {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 12px;
            font-size: 13px;
            color: #666;
          }
          .week-dots {
            display: flex;
            gap: 4px;
          }
          .week-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #ddd;
          }
          .week-dot.completed {
            background: #A89968;
          }
          .dashboard-layout {
            display: grid;
            grid-template-columns: 2.2fr 1.2fr;
            gap: 20px;
            margin-bottom: 30px;
          }
          @media (max-width: 1024px) {
            .dashboard-layout {
              grid-template-columns: 1fr;
            }
          }
          @media (max-width: 600px) {
            body { padding: 10px; }
            .header { padding: 14px; }
            .header h1 { font-size: 18px; }
            /* Several buttons/links were built with white-space: nowrap,
               which is fine on desktop but forces horizontal overflow on a
               narrow phone screen since the text can't wrap or shrink.
               Letting them wrap and go full-width on small screens fixes
               the "page is too wide" problem on mobile. */
            a[style*="white-space: nowrap"],
            button[style*="white-space: nowrap"] {
              white-space: normal !important;
              width: 100%;
              text-align: center;
              box-sizing: border-box;
            }
            /* Banners that put a label and a button side-by-side need to
               stack on narrow screens instead of squeezing both onto one
               line. Deliberately specific (matches flex-wrap:wrap too) so
               this doesn't also catch the check-in modal's title/close-
               button row, which should stay side-by-side on mobile too. */
            div[style*="justify-content: space-between"][style*="flex-wrap: wrap"] {
              flex-direction: column;
              align-items: stretch !important;
            }
            /* Photo-upload mini-form + primary CTA button row (above the
               Baseline Score box): the file input has a fixed 100px width
               and the button's text can't fit alongside it in the space
               left on a narrow phone. Letting the row wrap — combined with
               the white-space:normal + width:100% rule above, which already
               applies to this button — drops the button cleanly onto its
               own line under the photo form instead of forcing both onto
               one line and overflowing the card. */
            .photo-and-checkin-row {
              flex-wrap: wrap;
            }
            /* Baseline Score shares .baseline-info-grid's 2-column row with
               Current Streak on desktop, which only leaves it half the
               card's width — cramped for 4 mini-columns (Mobility/Energy/
               Appetite/Weight) on a narrow phone. Spanning it across both
               grid columns gives it the full row; Current Streak and Best
               Streak then auto-flow onto their own 2-column row beneath it. */
            .baseline-score-item {
              grid-column: 1 / -1;
            }
          }
          .metrics-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .metric-card {
            background: #FAFAF8;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
            border: 1px solid #E8E4DA;
          }
          .metric-card h3 { color: #999; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
          .metric-value { font-size: 24px; font-weight: 500; color: #2C2C2C; margin-bottom: 6px; }
          .metric-label { font-size: 13px; color: #999; }
          .trend-indicator {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 16px;
            font-size: 11px;
            font-weight: 600;
            margin-top: 8px;
            background: #F0F0F0;
            color: #666;
          }
          .chart-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .chart-card h2 { font-size: 16px; color: #2C2C2C; margin-bottom: 15px; font-weight: 500; }
          #mobilityChart { max-height: 280px; }
          .tips-card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            margin-bottom: 16px;
          }
          .tips-card:last-child { margin-bottom: 0; }
          .tips-card h2 { font-size: 15px; color: #2C2C2C; margin-bottom: 10px; font-weight: 700; }
          .tip-item {
            font-size: 13px;
            line-height: 1.6;
            color: #666;
            margin: 0;
          }
          .peer-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .peer-card h2 { font-size: 16px; color: #2C2C2C; margin-bottom: 15px; font-weight: 500; }
          .peer-stat {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid #E8E4DA;
            font-size: 13px;
          }
          .peer-stat:last-child { border-bottom: none; }
          .peer-stat-label { color: #999; font-weight: 400; }
          .peer-stat-value { font-size: 18px; font-weight: 500; color: #2C2C2C; }
          .rank-badge {
            display: inline-block;
            background: #D4AF88;
            color: white;
            padding: 6px 14px;
            border-radius: 16px;
            font-weight: 500;
            font-size: 12px;
            margin-top: 10px;
          }
          .back-link {
            color: #A89968;
            text-decoration: none;
            font-size: 13px;
            display: inline-block;
            margin-bottom: 20px;
            font-weight: 500;
          }
          .back-link:hover { color: #8B7D5B; }
          .baseline-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
            margin-bottom: 30px;
          }
          button {
            font-family: inherit;
          }
          button:hover {
            opacity: 0.9;
          }
          .baseline-photo {
            text-align: center;
            position: relative;
            width: 80px;
            height: 80px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .baseline-photo img {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            object-fit: cover;
          }
          .baseline-photo-placeholder {
            width: 80px;
            height: 80px;
            background: #E8E4DA;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            color: #bbb;
          }
          .baseline-info {
            display: flex;
            flex-direction: column;
          }
          .baseline-info h2 {
            font-size: 24px;
            color: #2C2C2C;
            margin-bottom: 15px;
            font-weight: 500;
          }
          .baseline-info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-bottom: 15px;
          }
          .baseline-info-item {
            padding: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .baseline-info-label {
            font-size: 11px;
            color: #999;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 5px;
            font-weight: 600;
          }
          .baseline-info-value {
            font-size: 18px;
            font-weight: 500;
            color: #2C2C2C;
          }
          .baseline-notes {
            padding: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            margin-top: 15px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .baseline-notes p {
            font-size: 13px;
            color: #555;
            line-height: 1.5;
            margin: 0;
          }
          .btn-primary {
            background: #A89968;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.2s;
          }
          .btn-primary:hover {
            opacity: 0.85;
          }
          .btn-secondary {
            background: #D4AF88;
            color: white;
            border: none;
            padding: 8px 14px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.2s;
          }
          .btn-secondary:hover {
            opacity: 0.85;
          }
          ${SCORE_ITEM_WIDGET_STYLES}
        </style>
      </head>
      <body>
        <div class="container">
          <a href="/check-in/${dog_id}" class="back-link">← Back to Check-In</a>
          ${dog.owner_id ? `<a href="/add-dog.html?owner_id=${dog.owner_id}" class="back-link" style="margin-left: 16px;">+ Add Another Dog</a>` : ''}
          ${dog.owner_id ? `<a href="/checkins/${dog.owner_id}" class="back-link" style="margin-left: 16px;">View All My Dogs</a>` : ''}
          ${dogSwitcherHtml}

          <div class="header">
            <div style="margin: 0 0 14px 0;">${buildBrandLockup({ iconPx: 30, fontPx: 18 })}</div>
            <h1><i data-lucide="bar-chart-3"></i> ${escapeHtml(dog.dog_name)}'s Mobility Dashboard</h1>
            <p>${escapeHtml(dog.breed) || ''} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}</p>
            <div class="week-progress">
              <span>Baseline ✓</span>
              <span>·</span>
              <span>${formatProgramWeekLabel(mostRecentSubmittedWeek)}</span>
              <div class="week-dots">
                ${Array.from({length: 12}, (_, i) => {
                  const weekNum = i + 1;
                  const isCompleted = weekNum <= mostRecentSubmittedWeek;
                  return `<div class="week-dot ${isCompleted ? 'completed' : ''}"></div>`;
                }).join('')}
              </div>
              ${mostRecentSubmittedWeek > 12 ? `<p style="margin: 6px 0 0 0; font-size: 12px; color: #999;">${mostRecentSubmittedWeek - 12} week${mostRecentSubmittedWeek - 12 === 1 ? '' : 's'} logged beyond the original 12.</p>` : ''}
            </div>
            ${isSenior ? `<p style="margin: 8px 0 0 0; font-size: 13px; color: #666;">${escapeHtml(dog.dog_name)} is considered a senior for their breed.</p>` : ''}
          </div>

          ${isInBaselinePeriod ? `
          <div style="background: #EEF2F5; border-left: 4px solid #8B9BA8; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="margin: 0; color: #4A5A66; font-size: 14px;"><i data-lucide="clipboard-list"></i> ${escapeHtml(dog.dog_name)}'s first weekly update will be ready in ${daysUntilFirstUpdate} day${daysUntilFirstUpdate === 1 ? '' : 's'}. You'll get a text when it's time.</p>
          </div>
          ` : hasUpdateDue ? `
          <div style="background: #FFF8E7; border-left: 4px solid #A89968; border-radius: 8px; padding: 16px 20px; margin: 20px 0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div>
              <p style="margin: 0 0 4px 0; font-weight: 600; color: #8A7A4F; font-size: 14px;"><i data-lucide="clipboard-edit"></i> Week ${dueWeekNumber} update due</p>
              <p style="margin: 0; color: #5D4E37; font-size: 14px;">Takes about 30 seconds.</p>
            </div>
            <a href="/check-in/${dog_id}" style="background: #A89968; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap;">Complete Week ${dueWeekNumber} Update →</a>
          </div>
          ` : ''}

          ${activeAlert ? `
          <div style="background: #FFF3E0; border-left: 4px solid #FF9800; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="margin: 0 0 4px 0; font-weight: 600; color: #E65100; font-size: 14px;">⚠️ Worth a look</p>
            <p style="margin: 0; color: #5D4037; font-size: 14px; line-height: 1.5;">${escapeHtml(activeAlert.message)}</p>
          </div>
          ` : ''}

          ${BREED_GUIDE_CHAPTER_WEEKS.includes(nextCheckinWeekNumber) ? `
          <div style="background: #FFF8E7; border-left: 4px solid #A89968; border-radius: 8px; padding: 16px 20px; margin: 20px 0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div>
              <p style="margin: 0 0 4px 0; font-weight: 600; color: #8A7A4F; font-size: 14px;"><i data-lucide="book-open"></i> Breed guide unlocked</p>
              <p style="margin: 0; color: #5D4E37; font-size: 14px;">${escapeHtml(dog.dog_name)}'s ${escapeHtml(dog.breed) || 'breed'} guide is ready to read.</p>
            </div>
            <a href="/breed-guide/${dog_id}" style="background: #A89968; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap;">Read it →</a>
          </div>
          ` : ''}

          ${nextCheckinWeekNumber === PROGRAM_COMPLETE_WEEK ? `
          <div style="background: #FFF8E7; border-left: 4px solid #A89968; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="margin: 0 0 4px 0; font-weight: 600; color: #8A7A4F; font-size: 14px;"><i data-lucide="award"></i> 12-week program complete</p>
            <p style="margin: 0; color: #5D4E37; font-size: 14px;">${escapeHtml(dog.dog_name)} completed the original 12-week check-in plan. ${PROGRAM_CONTINUATION_NOTE}</p>
          </div>
          ` : ''}

          <div class="peer-card" style="margin: 20px 0;">
            <h2>Health Summary</h2>
            ${dashboardHealthSummary.map(p => `<p style="margin: 0 0 10px 0; font-size: 14px; color: #2C2C2C; line-height: 1.6;">${p}</p>`).join('')}
          </div>

          <div class="dashboard-layout">
            <!-- LEFT COLUMN: DOG INFO + CHARTS -->
            <div>
              <div class="baseline-card">
                <div style="display: flex; gap: 15px; align-items: flex-start; margin-bottom: 20px;">
                  <div class="baseline-photo">
                    ${dog.photo_url
                      ? `<img src="${dog.photo_url}" alt="${escapeHtml(dog.dog_name)}" />`
                      : `<div class="baseline-photo-placeholder"><i data-lucide="paw-print"></i></div>`
                    }
                  </div>
                  <div style="flex: 1;">
                    <h2 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 500; color: #2C2C2C;">${escapeHtml(dog.dog_name)}'s Health Journey</h2>
                    <p style="margin: 0 0 4px 0; font-size: 13px; color: #999; font-weight: 400;">
                      ${escapeHtml(dog.breed) || 'Breed unknown'} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}
                      ${dog.spayed_neutered ? ` • ${dog.spayed_neutered === 'yes' ? 'Fixed' : 'Not Fixed'}` : ''}
                      ${dog.diet_type ? ` • ${DIET_TYPE_LABELS[dog.diet_type] || dog.diet_type}` : ''}
                      ${dog.pet_insurance ? ` • ${dog.pet_insurance === 'yes' ? 'Insured' : dog.pet_insurance === 'no' ? 'No Insurance' : 'Insurance Unknown'}` : ''}
                    </p>
                    ${(() => {
                      const meds = (dog.treatment_category || [])
                        .filter(t => t !== 'none' && TREATMENT_CATEGORY_LABELS[t])
                        .map(t => TREATMENT_CATEGORY_LABELS[t]);
                      return meds.length > 0
                        ? `<p style="margin: 0 0 12px 0; font-size: 13px; color: #999; font-weight: 400;">${meds.join(' - ')}</p>`
                        : '';
                    })()}
                    <div class="photo-and-checkin-row" style="display: flex; gap: 8px; margin-bottom: 12px;">
                      <div style="display: flex; gap: 4px; align-items: center;">
                        <input type="file" id="quickPhotoInput" accept="image/*" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;">
                        <button type="button" id="quickPhotoTriggerBtn" class="btn-secondary"><i data-lucide="camera"></i> Update ${escapeHtml(dog.dog_name)}'s Photo</button>
                      </div>
                      ${isInBaselinePeriod ? `
                      <button class="btn-primary" disabled style="white-space: nowrap; padding: 8px 16px; opacity: 0.5; cursor: not-allowed;">
                        Available in ${daysUntilFirstUpdate} day${daysUntilFirstUpdate === 1 ? '' : 's'}
                      </button>
                      ` : `
                      <button id="openCheckInBtn" class="btn-primary" style="white-space: nowrap; padding: 8px 16px;">
                        ${hasUpdateDue ? `Complete Week ${dueWeekNumber} Update` : "Share This Week's Update"}
                      </button>
                      `}
                    </div>
                  </div>
                </div>
                <div class="baseline-info">
                  <div class="baseline-info-grid">
                    <div class="baseline-info-item baseline-score-item">
                      <div class="baseline-info-label">Baseline Score</div>
                      <div style="display: flex; gap: 8px; margin-top: 4px;">
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Mobility</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_mobility_score ?? '—'}/10</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Energy</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_energy_score ?? '—'}/10</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Appetite</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_appetite_score ?? '—'}/10</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Weight</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.weight_lbs ?? '—'} lb</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Cognitive</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_cognitive_score ?? '—'}/10</div>
                        </div>
                      </div>
                    </div>
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Current Streak</div>
                      <div class="baseline-info-value">${streak > 0 ? '<i data-lucide="flame" style="width:14px;height:14px;vertical-align:-2px;"></i> ' : ''}${streak}w</div>
                      <p style="margin: 4px 0 0 0; font-size: 11px; color: #999;">${streak > 0 ? 'Keep it going!' : 'Complete your first check-in to start a streak'}</p>
                    </div>
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Best Streak</div>
                      <div class="baseline-info-value">${dog.longest_streak || streak}w</div>
                    </div>
                  </div>
                  ${dog.baseline_notes ? `
                  <div class="baseline-notes">
                    <p><strong>Baseline Notes:</strong> ${escapeHtml(dog.baseline_notes)}</p>
                  </div>
                  ` : ''}
                </div>
              </div>

              <div class="chart-card">
                <h2>Health observations over time</h2>
                <canvas id="mobilityChart"></canvas>
                <p style="font-size: 12px; color: #999; margin: 16px 0 6px 0;">Exact values by week (scroll sideways if needed):</p>
                <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                  <table style="border-collapse: collapse; width: 100%; min-width: ${Math.max(300, chartWeeks.length * 55)}px; font-size: 13px;">
                    <thead>
                      <tr>
                        <th style="text-align: left; padding: 6px 10px; border-bottom: 2px solid #EEE; color: #999; font-weight: 500; white-space: nowrap;"></th>
                        ${chartWeeks.map(w => `<th style="text-align: center; padding: 6px 10px; border-bottom: 2px solid #EEE; color: #999; font-weight: 500; white-space: nowrap;">${escapeHtml(w)}</th>`).join('')}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style="padding: 6px 10px; color: #667eea; font-weight: 600; white-space: nowrap;">Mobility</td>
                        ${chartScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                      <tr>
                        <td style="padding: 6px 10px; color: #F5A623; font-weight: 600; white-space: nowrap;">Energy</td>
                        ${chartEnergyScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                      <tr>
                        <td style="padding: 6px 10px; color: #4CAF50; font-weight: 600; white-space: nowrap;">Appetite</td>
                        ${chartAppetiteScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                      <tr>
                        <td style="padding: 6px 10px; color: #9B59B6; font-weight: 600; white-space: nowrap;">Cognitive</td>
                        ${chartCognitiveScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              ${showWeightChart ? `
              <div class="chart-card">
                <h2>Weight</h2>
                <p style="margin: 0 0 12px 0; font-size: 13px; color: #888;">You're seeing this graph because ${escapeHtml(dog.dog_name)} is considered overweight for their size. This reflects just ${escapeHtml(dog.dog_name)}'s own recorded weight — not a diagnosis or a comparison to other dogs.</p>
                <canvas id="weightChart" style="max-height: 160px;"></canvas>
              </div>
              ` : ''}

              <div class="chart-card">
                <h2><i data-lucide="file-text"></i> Notes</h2>
                <p style="font-size: 13px; color: #999; margin: -8px 0 16px 0;">Jot down anything worth remembering between check-ins — these are saved with ${escapeHtml(dog.dog_name)}'s health journey.</p>
                <form id="addNoteForm" style="display: flex; gap: 8px; margin-bottom: 16px;">
                  <input type="text" id="noteInput" placeholder="e.g. Seemed stiffer after our walk today" maxlength="500" style="flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px;" required>
                  <button type="submit" style="background: #A89968; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap;">Add Note</button>
                </form>
                <div id="notesList">
                  ${dogNotes && dogNotes.length > 0
                    ? dogNotes.map(n => `
                      <div style="padding: 10px 0; border-bottom: 1px solid #F0EDE5;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #2C2C2C;">${escapeHtml(n.note_text)}</p>
                        <p style="margin: 0; font-size: 12px; color: #AAA;">${new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                    `).join('')
                    : `<p style="font-size: 13px; color: #AAA; text-align: center; padding: 10px 0;">No notes yet — add one whenever something's worth remembering.</p>`
                  }
                </div>
              </div>

              <div class="peer-card">
                <h2>How ${escapeHtml(dog.dog_name)} compares across the community</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Your dog's rank</span>
                  <span class="peer-stat-value">#${rank} / ${totalDogs}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Community average score</span>
                  <span class="peer-stat-value">${peerAverage}/10</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Status</span>
                  <!-- STEP P10: wording rewritten, not just re-triggered on the
                       flipped comparison — the old "Above average!" framing
                       (exclamation point, positive-coded) was already a soft
                       value judgment that happened to align with "more=good"
                       under the old scale. Continuing it under the new scale
                       would mean celebrating a HIGHER (more concerning) score,
                       a real violation of "never make a health judgment."
                       Neutral factual comparison instead. -->
                  <span class="peer-stat-value" style="font-size: 14px; color: #A89968; font-weight: 600;"><i data-lucide="target"></i> ${currentScore < parseFloat(peerAverage) ? 'Lower than the community average' : currentScore === parseFloat(peerAverage) ? 'About the same as the community average' : 'Higher than the community average'}</span>
                </div>
                <p style="margin: 12px 0 0 0; font-size: 12px; color: #999; line-height: 1.5;">This compares ${escapeHtml(dog.dog_name)} to all dogs currently logging, not specifically ${escapeHtml(dog.breed) || 'this breed'} — breed-specific comparisons will be added once enough dogs of the same breed are logging regularly.</p>
              </div>
            </div>

            <!-- MIDDLE COLUMN: SUMMARY -->
            <div>
              <div class="peer-card">
                <h2>This week at a glance</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Mobility</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentScore, previousScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Energy</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentEnergyScore, previousEnergyScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Appetite</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentAppetiteScore, previousAppetiteScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Weight</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeWeightTrendForGlance(currentWeightValue, previousWeightValue)}</span>
                </div>
              </div>
            </div>

          </div>

          <!-- BOTTOM SECTION: INFO & SUMMARY -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <p style="margin: 0; font-size: 13px; color: #2C2C2C; line-height: 1.6;">
                Based on anonymized observations from all dogs currently logging on Companion Commons, not specifically ${escapeHtml(dog.breed) || 'this breed'}. For context only — not a diagnosis or veterinary assessment.
              </p>
            </div>

            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <i data-lucide="circle-help" style="width: 20px; height: 20px; flex-shrink: 0;"></i>
                <div>
                  <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 500; color: #2C2C2C;">Prepare for a conversation with ${escapeHtml(dog.dog_name)}'s vet, family, babysitter etc.</p>
                  <p style="margin: 0; font-size: 13px; color: #2C2C2C;">Review recent notes and highlights to help you share what matters most.</p>
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 15px; margin-bottom: 30px; flex-wrap: wrap;">
            <button id="viewSummaryBtn" style="flex: 1; min-width: 220px; background: #A89968; color: white; border: none; padding: 16px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer;">
              Click to View ${escapeHtml(dog.dog_name)}'s Journey Summary
            </button>
            <button id="openDocLibraryBtn" style="flex: 1; min-width: 220px; background: #A89968; color: white; border: none; padding: 16px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer;">
              <i data-lucide="book-open"></i> Document Library
            </button>
          </div>

          <p style="font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 14px; margin: 0;">
            Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.
          </p>
        </div>

        <!-- CHECK-IN MODAL -->
        <div id="checkInModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div style="background: white; margin: 20px auto; border-radius: 12px; padding: 30px; max-width: 500px; position: relative; top: 50px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <h2 style="margin: 0; color: #333;"><i data-lucide="clipboard-check"></i> ${escapeHtml(dog.dog_name)}'s Check-In</h2>
              <button id="closeCheckInBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
            </div>

            <form id="checkInForm">
              <h3 style="font-size: 15px; font-weight: 600; color: #333; margin: 0 0 4px 0;">Mobility</h3>
              ${buildDomainItemWidgetsHtml('mobility', mobilityPrefill)}

              <h3 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Energy</h3>
              ${buildSingleItemWidgetHtml('energy', latestEnergyScore)}

              <h3 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Appetite</h3>
              ${buildSingleItemWidgetHtml('appetite', latestAppetiteScore)}

              ${buildMedicationUpdateSectionHtml(activeMedicationsForModal)}

              ${showCognitiveThisWeek ? `
              <h3 style="font-size: 15px; font-weight: 600; color: #333; margin: 24px 0 4px 0;">Cognitive &amp; Behavior</h3>
              <p style="font-size: 12px; color: #666; margin: 0 0 16px 0;">Asked every 4th week.</p>
              ${buildDomainItemWidgetsHtml('cognitive', cognitivePrefill)}
              ` : ''}

              ${showCognitiveThisWeek ? `
              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">${escapeHtml(dog.dog_name)}'s weight this week (lbs)</label>
              <input type="number" id="weight" name="weight_lbs" min="1" max="250" value="${latestWeightScore}" placeholder="e.g. 62" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box;">
              <div style="font-size: 12px; color: #666; margin: 5px 0 0 0;">Optional — tracked alongside mobility, energy, and appetite.</div>
              ` : ''}

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">Any notes? (optional)</label>
              <textarea id="observation" name="observation" placeholder="E.g., 'Easier on stairs this week' or 'Stiff in morning'" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box; height: 80px;"></textarea>

              <button type="submit" style="background: #A89968; color: white; border: none; padding: 15px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 20px; font-weight: 500;">Submit Check-In ✓</button>
            </form>
          </div>
        </div>

        <!-- JOURNEY SUMMARY MODAL -->
        <div id="journeySummaryModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div id="journeySummaryPrintArea" style="background: white; margin: 20px auto; border-radius: 12px; padding: 14px; max-width: 650px; position: relative; top: 30px; border: 2px solid #D4CDB8;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;" class="no-print">
              <h2 style="margin: 0; color: #333;"><i data-lucide="clipboard-list"></i> ${escapeHtml(dog.dog_name)}'s Journey Summary</h2>
              <button id="closeJourneyBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
            </div>

            <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px;">
              ${dog.photo_url
                ? `<img src="${dog.photo_url}" alt="${escapeHtml(dog.dog_name)}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; flex-shrink: 0;" />`
                : `<div style="width: 64px; height: 64px; border-radius: 50%; background: #FFF8E7; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i data-lucide="paw-print" style="width: 28px; height: 28px;"></i></div>`
              }
              <div>
                <div style="margin: 0 0 4px 0;">${buildBrandLockup({ iconPx: 22, fontPx: 13 })}</div>
                <h3 style="margin: 0; font-size: 18px; color: #2C2C2C;">${escapeHtml(dog.dog_name)}'s Journey Summary</h3>
              </div>
            </div>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #666;">
              ${escapeHtml(dog.breed) || 'Breed unknown'} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}
              ${dog.spayed_neutered ? ` • ${dog.spayed_neutered === 'yes' ? 'Fixed' : 'Not Fixed'}` : ''}
              ${dog.diet_type ? ` • ${DIET_TYPE_LABELS[dog.diet_type] || dog.diet_type}` : ''}
              ${dog.pet_insurance ? ` • ${dog.pet_insurance === 'yes' ? 'Insured' : dog.pet_insurance === 'no' ? 'No Insurance' : 'Insurance Unknown'}` : ''}
            </p>
            ${(() => {
              const journeyMeds = (dog.treatment_category || [])
                .filter(t => t !== 'none' && TREATMENT_CATEGORY_LABELS[t])
                .map(t => TREATMENT_CATEGORY_LABELS[t]);
              return journeyMeds.length > 0
                ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: #666;">Medications/treatments: ${journeyMeds.join(', ')}</p>`
                : `<p style="margin: 0 0 8px 0; font-size: 13px; color: #666;"></p>`;
            })()}
            <p style="margin: 0 0 6px 0; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999;">Prepared ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · Baseline ✓ · ${formatProgramWeekLabel(mostRecentSubmittedWeek)}</p>

            <hr style="border: none; border-top: 1.5px solid #D4CDB8; margin: 0 0 8px 0;">

            ${journeyAlertHtml}

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Summary</h3>
            <div style="margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              ${reportHealthSummary.map(p => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #2C2C2C;">${p}</p>`).join('')}
            </div>

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Trends since baseline</h3>
            <div style="background: #FAFAF8; border-radius: 8px; padding: 6px 16px; margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              ${journeyTrendLines.map(line => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #2C2C2C;">${line}</p>`).join('')}
            </div>

            <!-- Chart snapshot: visible in the on-screen modal at all times,
                 not just in print, so what John sees before printing matches
                 what actually prints. Populated from the live Chart.js
                 canvas via toDataURL as soon as the modal opens (see
                 viewSummaryBtn's click handler) — reuses the exact same
                 chart already rendered on the dashboard instead of
                 maintaining a second one. Height is capped (with
                 object-fit:contain so nothing distorts) since the on-screen
                 canvas can render fairly tall on a wide desktop viewport —
                 this keeps the printed summary from growing past one page
                 for a typical baseline-only case. -->
            <div id="journeyChartPrintOnly" style="margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              <img id="journeyChartImg" style="width: 100%; max-width: 100%; max-height: 160px; object-fit: contain; display: block;" alt="${escapeHtml(dog.dog_name)}'s mobility, energy, and appetite chart" />
              <p style="margin: 4px 0 0 0; font-size: 11px; color: #999; line-height: 1.4;">As ${escapeHtml(dog.dog_name)}'s weekly health journey updates are submitted, this chart will contain more information, giving you a better health journey picture.</p>
            </div>

            <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 8px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C; break-after: avoid; page-break-after: avoid;">Weekly log</h3>
            ${journeyTableRows ? `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; break-inside: avoid; page-break-inside: avoid;">
              <thead>
                <tr style="background: #FAFAF8;">
                  <th style="padding: 8px 10px; text-align: left; font-weight: 600; color: #666;">Week</th>
                  <th style="padding: 8px 10px; text-align: left; font-weight: 600; color: #666;">Date</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Mobility</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Energy</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Appetite</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Cognitive</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Weight</th>
                </tr>
              </thead>
              <tbody>
                ${journeyTableRows}
              </tbody>
            </table>
            ` : `<p style="font-size: 14px; color: #888; margin-bottom: 10px;">No weekly check-ins yet — this will fill in after ${escapeHtml(dog.dog_name)}'s first update.</p>`}

            <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 8px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Notes</h3>
            <div style="margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              ${journeyNotesHtml}
            </div>

            <p style="font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 8px; margin: 0;">
              Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.
            </p>
            <p style="font-size: 12px; color: #999; margin: 4px 0 0 0;">
              As community grows, comparisons will also print on this summary as well.
            </p>

            <div class="no-print" style="display: flex; gap: 12px; margin-top: 20px;">
              <button id="printJourneyBtn" style="flex: 1; background: #A89968; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;"><i data-lucide="printer"></i> Print / Save as PDF</button>
            </div>
          </div>
        </div>

        <!-- DOCUMENT LIBRARY MODAL -- same modal-open / on-screen-render /
             window.print() pattern as the Journey Summary modal above.
             Two states inside one modal: a menu of 4 rows, and a document
             view showing whichever pane the JS below reveals. All 4
             documents' real content is already in the DOM at page load
             (documentLibraryPanesHtml, computed server-side above) -- the
             JS only ever toggles display, never fetches or builds content. -->
        <div id="documentLibraryModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div id="documentLibraryBox" style="background: white; margin: 20px auto; border-radius: 12px; padding: 24px; max-width: 650px; position: relative; top: 30px; border: 2px solid #D4CDB8;">

            <div id="docLibraryMenu">
              <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <h2 style="margin: 0; color: #333;"><i data-lucide="book-open"></i> Document Library</h2>
                <button id="closeDocLibraryBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
              </div>
              <p style="font-size: 13px; color: #666; margin: 0 0 16px 0;">Personalized documents for ${escapeHtml(dog.dog_name)}, ready to view, print, or save as PDF.</p>
              <div>
                ${DOCUMENT_LIBRARY_ITEMS.map(item => `
                <button type="button" class="doc-library-row" data-doc="${item.docId}" style="display: block; width: 100%; text-align: left; background: #FAFAF8; border: 1px solid #E8E4DA; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; font-family: inherit;">
                  <strong style="display: block; font-size: 14px; color: #2C2C2C; margin-bottom: 3px;">${escapeHtml(item.title)}</strong>
                  <span style="display: block; font-size: 13px; color: #888;">${escapeHtml(item.description)}</span>
                </button>`).join('')}
              </div>
            </div>

            <div id="docLibraryDocumentView" style="display: none;">
              <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                <button type="button" id="backToDocListBtn" style="background: none; border: none; color: #A89968; font-size: 14px; font-weight: 500; cursor: pointer; padding: 0;">&larr; Back to Document Library</button>
                <button id="closeDocLibraryBtn2" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
              </div>
              ${documentLibraryPanesHtml}
            </div>

          </div>
        </div>

        <style>
          @media print {
            /* display:none (not visibility:hidden) actually removes hidden
               content from the layout flow. visibility:hidden kept
               .container's full multi-page height even while invisible, so
               the browser generated that many pages and repeated the
               absolutely-positioned print area on each one. Hiding every
               direct body child except the open modal (the real ancestor
               of the print area) collapses the printed page down to the
               print area's actual height. */
            body > *:not(#journeySummaryModal):not(#documentLibraryModal) { display: none !important; }
            #journeySummaryModal, #documentLibraryModal { position: static !important; background: none !important; overflow: visible !important; z-index: auto !important; }
            #journeySummaryPrintArea, #documentLibraryBox { position: absolute; top: 0; left: 0; width: 100%; margin: 0; box-shadow: none; }
            .no-print { display: none !important; }
          }
        </style>

        <script>
          // Modal controls
          const modal = document.getElementById('checkInModal');
          const openBtn = document.getElementById('openCheckInBtn');
          const closeBtn = document.getElementById('closeCheckInBtn');

          ${SCORE_ITEM_WIDGET_SCRIPT}
          ${MEDICATION_UPDATE_SCRIPT}

          // openBtn won't exist during the baseline period (disabled button
          // has no id then) — guard so this doesn't crash the rest of the
          // page's JS (photo upload, chart rendering, etc.)
          if (openBtn) {
            openBtn.addEventListener('click', () => {
              modal.style.display = 'block';
            });
          }

          // Mid-week notes — submits via the API, then reloads to show it
          // in the list. Simple and reliable; no need for fancier in-place
          // DOM updates for something used this occasionally.
          const addNoteForm = document.getElementById('addNoteForm');
          if (addNoteForm) {
            addNoteForm.addEventListener('submit', async (e) => {
              e.preventDefault();
              const input = document.getElementById('noteInput');
              const text = input.value.trim();
              if (!text) return;

              try {
                const response = await fetch('/api/notes/${dog_id}', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ note_text: text })
                });
                if (response.ok) {
                  window.location.reload();
                } else {
                  alert('Could not save note. Please try again.');
                }
              } catch (err) {
                console.error('Error saving note:', err);
                alert('Could not save note. Please try again.');
              }
            });
          }

          closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
          });

          modal.addEventListener('click', (e) => {
            if (e.target === modal) {
              modal.style.display = 'none';
            }
          });

          // Journey Summary — opens a real modal built from actual check-in
          // history, notes, and any active alert (see journeySummaryModal below).
          const journeyModal = document.getElementById('journeySummaryModal');
          document.getElementById('viewSummaryBtn').addEventListener('click', () => {
            journeyModal.style.display = 'block';
            // Snapshot the live Chart.js canvas as a static image as soon as
            // the modal opens, not at print time — so what's shown on screen
            // in the modal is exactly what prints, instead of the chart
            // appearing invisibly only once Print is clicked. Reuses the
            // exact same chart already rendered on the dashboard instead of
            // maintaining a second one.
            const mobilityCanvas = document.getElementById('mobilityChart');
            const journeyChartImg = document.getElementById('journeyChartImg');
            if (mobilityCanvas && journeyChartImg) {
              journeyChartImg.src = mobilityCanvas.toDataURL('image/png');
            }
          });
          document.getElementById('closeJourneyBtn').addEventListener('click', () => {
            journeyModal.style.display = 'none';
          });
          document.getElementById('printJourneyBtn').addEventListener('click', () => {
            window.print();
          });

          // Document Library — same modal-open pattern as Journey Summary
          // above, plus a menu/document-view toggle within one modal. All 4
          // documents' content is already in the DOM (documentLibraryPanesHtml,
          // rendered server-side) -- these handlers only ever show/hide,
          // never fetch or build content.
          const docLibraryModal = document.getElementById('documentLibraryModal');
          const docLibraryMenu = document.getElementById('docLibraryMenu');
          const docLibraryDocumentView = document.getElementById('docLibraryDocumentView');

          function openDocLibraryMenu() {
            docLibraryModal.style.display = 'block';
            docLibraryMenu.style.display = 'block';
            docLibraryDocumentView.style.display = 'none';
          }
          function closeDocLibrary() {
            docLibraryModal.style.display = 'none';
          }

          document.getElementById('openDocLibraryBtn').addEventListener('click', openDocLibraryMenu);
          document.getElementById('closeDocLibraryBtn').addEventListener('click', closeDocLibrary);
          document.getElementById('closeDocLibraryBtn2').addEventListener('click', closeDocLibrary);
          document.getElementById('backToDocListBtn').addEventListener('click', () => {
            docLibraryDocumentView.style.display = 'none';
            docLibraryMenu.style.display = 'block';
          });
          document.querySelectorAll('.doc-library-row').forEach((row) => {
            row.addEventListener('click', () => {
              docLibraryMenu.style.display = 'none';
              docLibraryDocumentView.style.display = 'block';
              document.querySelectorAll('.document-pane').forEach((pane) => { pane.style.display = 'none'; });
              const pane = document.getElementById('doc-' + row.dataset.doc);
              if (pane) pane.style.display = 'block';
            });
          });
          document.querySelectorAll('.print-doc-btn').forEach((btn) => {
            btn.addEventListener('click', () => { window.print(); });
          });

          // Form submission
          document.getElementById('checkInForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const scoreCheck = formHasAllScoreItemsAnswered(e.target);
            if (!scoreCheck.valid) {
              highlightUnansweredScoreItem(scoreCheck.firstInvalid);
              return;
            }

            const medCheck = medicationUpdateSectionIsValid();
            if (!medCheck.valid) {
              alert(medCheck.message);
              return;
            }

            const formData = new FormData(e.target);
            const medAnswer = formData.get('medication_update_answer');
            try {
              const response = await fetch('/api/checkin-senior', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  dog_id: '${dog_id}',
                  mobility_getting_up: parseInt(formData.get('mobility_getting_up')),
                  mobility_stairs: parseInt(formData.get('mobility_stairs')),
                  mobility_stiffness_after_rest: parseInt(formData.get('mobility_stiffness_after_rest')),
                  mobility_walk_distance: parseInt(formData.get('mobility_walk_distance')),
                  energy_score: parseInt(formData.get('energy_score')),
                  appetite_score: parseInt(formData.get('appetite_score')),
                  cognitive_orientation: formData.get('cognitive_orientation') ? parseInt(formData.get('cognitive_orientation')) : null,
                  cognitive_memory: formData.get('cognitive_memory') ? parseInt(formData.get('cognitive_memory')) : null,
                  cognitive_interest: formData.get('cognitive_interest') ? parseInt(formData.get('cognitive_interest')) : null,
                  cognitive_sleep_wake: formData.get('cognitive_sleep_wake') ? parseInt(formData.get('cognitive_sleep_wake')) : null,
                  weight_lbs: formData.get('weight_lbs') ? parseInt(formData.get('weight_lbs')) : null,
                  observation: formData.get('observation') || null,
                  medication_id: medAnswer === 'yes' ? (formData.get('medication_id') || null) : null,
                  medication_change_type: medAnswer === 'yes' ? (formData.get('medication_change_type') || null) : null,
                  medication_update_note: medAnswer === 'yes' ? (formData.get('medication_update_note') || null) : null
                })
              });

              const result = await response.json();

              if (result.success) {
                modal.style.display = 'none';
                // Reload dashboard to show updated data
                location.reload();
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error submitting check-in. Please try again.');
            }
          });

          // Quick photo upload
          document.getElementById('quickPhotoTriggerBtn').addEventListener('click', () => {
            document.getElementById('quickPhotoInput').click();
          });

          document.getElementById('quickPhotoInput').addEventListener('change', async () => {
            const photoInput = document.getElementById('quickPhotoInput');

            if (!photoInput.files.length) {
              return;
            }

            const file = photoInput.files[0];
            const maxSize = 5 * 1024 * 1024; // 5MB

            if (file.size > maxSize) {
              alert('Photo must be less than 5MB');
              return;
            }

            const formData = new FormData();
            formData.append('photo', file);
            formData.append('dog_id', '${dog_id}');

            try {
              const response = await fetch('/api/upload-dog-photo', {
                method: 'POST',
                body: formData
              });

              const result = await response.json();

              if (result.success) {
                // Reload dashboard to show updated photo
                location.reload();
              } else {
                alert('Error: ' + (result.error || 'Upload failed'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error uploading photo. Please try again.');
            }
          });

          const ctx = document.getElementById('mobilityChart').getContext('2d');
          const chart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartWeeks)},
              datasets: [
                {
                  label: 'Mobility',
                  data: ${JSON.stringify(chartScores)},
                  borderColor: '#667eea',
                  backgroundColor: 'rgba(102, 126, 234, 0.08)',
                  borderWidth: 2,
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'circle',
                  pointRadius: 3,
                  pointBackgroundColor: '#667eea',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                },
                {
                  label: 'Energy',
                  data: ${JSON.stringify(chartEnergyScores)},
                  borderColor: '#F5A623',
                  backgroundColor: 'rgba(245, 166, 35, 0.08)',
                  borderWidth: 2,
                  borderDash: [6, 3],
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'triangle',
                  pointRadius: 3,
                  pointBackgroundColor: '#F5A623',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                },
                {
                  label: 'Appetite',
                  data: ${JSON.stringify(chartAppetiteScores)},
                  borderColor: '#4CAF50',
                  backgroundColor: 'rgba(76, 175, 80, 0.08)',
                  borderWidth: 2,
                  borderDash: [2, 2],
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'rect',
                  pointRadius: 3,
                  pointBackgroundColor: '#4CAF50',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                },
                {
                  label: 'Cognitive',
                  data: ${JSON.stringify(chartCognitiveScores)},
                  borderColor: '#9B59B6',
                  backgroundColor: 'rgba(155, 89, 182, 0.08)',
                  borderWidth: 2,
                  borderDash: [8, 3, 2, 3],
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'star',
                  pointRadius: 3,
                  pointBackgroundColor: '#9B59B6',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: {
                  display: true,
                  position: 'top',
                  labels: { font: { size: 12 }, usePointStyle: true, boxWidth: 8 }
                },
                tooltip: {
                  mode: 'index',
                  intersect: false
                }
              },
              interaction: {
                mode: 'index',
                intersect: false
              },
              scales: {
                y: {
                  beginAtZero: true,
                  max: 10,
                  ticks: { stepSize: 1 },
                  grid: { drawBorder: false }
                },
                x: {
                  grid: { display: false }
                }
              }
            }
          });

          ${showWeightChart ? `
          // Separate chart, own y-axis (lbs, not the 0-10 score scale) —
          // same x-axis weeks as the main chart above (not compressed to
          // only the weeks weight was recorded), so a weight change lines
          // up visually against that same week's mobility/energy movement.
          // Neutral brand color, not one of the four score-line colors, so
          // this doesn't read as "a 5th health metric" alongside them.
          const weightCtx = document.getElementById('weightChart').getContext('2d');
          new Chart(weightCtx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartWeeks)},
              datasets: [
                {
                  label: 'Weight (lb)',
                  data: ${JSON.stringify(chartWeightScores)},
                  borderColor: '#A89968',
                  backgroundColor: 'rgba(168, 153, 104, 0.08)',
                  borderWidth: 2,
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'circle',
                  pointRadius: 3,
                  pointBackgroundColor: '#A89968',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: { display: false },
                tooltip: { mode: 'index', intersect: false }
              },
              interaction: { mode: 'index', intersect: false },
              scales: {
                y: {
                  beginAtZero: false,
                  ticks: { callback: (value) => value + ' lb' },
                  grid: { drawBorder: false }
                },
                x: {
                  grid: { display: false }
                }
              }
            }
          });
          ` : ''}
        </script>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// ============================================
// GET ENDPOINTS (Dashboard/Testing)
// NEW ENDPOINTS
// ============================================
app.get('/api/user/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;

        const { data: user, error: userError } = await supabase
            .from('users')
            .select(`
                id, email, phone, status, created_at,
                pets (
                    id, name, breed, birthday, gender,
                    survey_baselines (health_score, activity_score, treatments),
                    survey_weekly_checkins (week_number, mobility_score, trend),
                    survey_enrichment (week_number, primary_goal, peer_comparison_interest)
                ),
                sms_preferences (preferred_time, frequency, sms_opted_out)
            `)
            .eq('id', user_id)
            .single();

        if (userError) throw userError;

        res.json({ success: true, user });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Error fetching user' });
    }
});

app.get('/api/pet/:pet_id/progress', async (req, res) => {
    try {
        const { pet_id } = req.params;

        const { data: checkins, error } = await supabase
            .from('survey_weekly_checkins')
            .select('week_number, mobility_score, trend, created_at')
            .eq('pet_id', pet_id)
            .order('week_number', { ascending: true });

        if (error) throw error;

        const completedWeeks = checkins.length;
        const weeksRemaining = Math.max(0, 12 - completedWeeks);

        res.json({
            pet_id,
            completed_weeks: completedWeeks,
            weeks_remaining: weeksRemaining,
            retention_rate: completedWeeks > 0 ? Math.round((completedWeeks / 12) * 100) : 0,
            progression: checkins
        });
    } catch (error) {
        console.error('Error fetching progress:', error);
        res.status(500).json({ error: 'Error fetching progress' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select(`
                id, email, phone, status, created_at,
                pets (
                    id, name
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, total: users.length, users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Error fetching users' });
    }
});

// ============================================
// BACKWARD COMPATIBILITY: Old /api/signups endpoint
// Returns data from Supabase (not signups.json)
// ============================================
app.get('/api/signups', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            total: users.length,
            signups: users
        });
    } catch (error) {
        console.error('Error fetching signups:', error);
        res.status(500).json({ error: 'Error fetching signups' });
    }
});

// ============================================
// GOVERNANCE: Live Metrics (Transparent Dashboard)
// ============================================
app.get('/api/governance/stats', async (req, res) => {
    try {
        // Signup count from senior_dogs — the real, live table. This used
        // to read from `users`, which is a fully abandoned parallel schema
        // (users/pets/survey_*/sms_preferences — confirmed at 0 rows, no FK
        // to senior_dogs, an earlier owner-entity attempt that was never
        // wired up) that never received data, so this endpoint always
        // reported zero regardless of real signups.
        const { count: dogCount, error: dogsError } = await supabase
            .from('senior_dogs')
            .select('id', { count: 'exact', head: true });

        if (dogsError) throw dogsError;
        const memberCount = dogCount || 0;

        // Today's model is one dog per signup, so "founding members" and
        // "pets registered" are the same count for now. These will only
        // diverge once a real Owner entity exists (see the multi-dog-owner
        // project) and can distinguish unique owners from unique dogs.
        const petsRegistered = memberCount;

        // SMS opt-in rate from senior_dogs.sms_consent — the real,
        // actively-used consent field (same one the churn cron and the
        // check-in reminder gate already check) — not the dead
        // sms_preferences table.
        const { count: smsOptIns, error: smsError } = await supabase
            .from('senior_dogs')
            .select('id', { count: 'exact', head: true })
            .eq('sms_consent', true);

        if (smsError) console.warn('SMS consent query issue:', smsError);
        const smsOptInCount = smsOptIns || 0;
        const smsOptInRate = memberCount > 0 ? Math.round((smsOptInCount / memberCount) * 100) : 0;

        // Weekly check-in count from mobility_checkins — the real
        // check-ins table, not the dead survey_weekly_checkins table.
        const { count: checkInCount, error: checkinsError } = await supabase
            .from('mobility_checkins')
            .select('id', { count: 'exact', head: true });

        if (checkinsError) console.warn('Check-ins query issue:', checkinsError);
        const weeklyCheckIns = checkInCount || 0;

        // Total data points = baseline assessments (one per dog) + weekly check-ins
        const totalDataPoints = memberCount + weeklyCheckIns;

        res.status(200).json({
            foundingMembers: memberCount,
            petsRegistered,
            totalDataPoints,
            weeklyCheckIns,
            smsOptInRate: `${smsOptInRate}%`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching governance stats:', error);
        res.status(500).json({
            error: 'Failed to fetch metrics',
            message: error.message
        });
    }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        supabase: 'connected'
    });
});

// ============================================
// TEST EMAIL (STEP 9 - Testing SendGrid)
// ============================================
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, dogName, lastScore, lastCheckInDate, dogId } = req.body;

    if (!email || !dogName || !dogId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, dogName, dogId'
      });
    }

    const result = await sendChurnAlertEmail(
      email,
      dogName,
      // ?? not || — same bug class as the two fixes in /api/checkin-senior
      // and evaluateDogForChurn (Stage 4a review): 0 is a legitimate
      // mobility score on the new 0-10 scale, and || would silently
      // override an intentional lastScore: 0 test payload with the default.
      lastScore ?? 5,
      lastCheckInDate || new Date().toISOString(),
      dogId
    );

    if (result.success) {
      res.json({
        success: true,
        message: `Test email sent to ${email}`
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// TEST CHURN DETECTION (STEP 10 - Manual trigger)
// ============================================
app.post('/api/test-churn-detection', async (req, res) => {
  try {
    console.log('🔍 Manual churn detection trigger...');
    let alertsSent = 0;
    let dogsChecked = 0;

    // Get all senior dogs
    const { data: allDogs } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, owner_id, baseline_mobility_score, created_at');

    if (!allDogs || allDogs.length === 0) {
      return res.json({
        success: true,
        message: 'No dogs found',
        dogsChecked: 0,
        alertsSent: 0
      });
    }

    dogsChecked = allDogs.length;
    const now = new Date();

    // For each dog, run the exact same shared evaluation the real cron uses
    // (see evaluateDogForChurn) — no SMS reminders (a manual trigger
    // shouldn't have SMS side effects). Then group by owner (STAGE 4) and
    // send, always to SENDGRID_FROM_EMAIL instead of the real owner, so a
    // test run never emails an actual user.
    const needsAlert = [];
    for (const dog of allDogs) {
      try {
        const result = await evaluateDogForChurn(dog);
        if (!result.skipped && result.needsAlert) needsAlert.push(result);
      } catch (dogError) {
        console.error(`Error processing dog ${dog.id}:`, dogError.message);
      }
    }

    const groups = new Map();
    for (const alert of needsAlert) {
      const key = alert.dog.owner_id || `solo:${alert.dog.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(alert);
    }

    for (const alerts of groups.values()) {
      const result = await sendChurnAlertsForOwnerGroup(null, alerts, { emailOverride: SENDGRID_FROM_EMAIL });
      if (result.sent) alertsSent += result.dogCount;
    }

    res.json({
      success: true,
      message: `Churn detection complete`,
      dogsChecked,
      alertsSent,
      timestamp: now.toISOString()
    });

  } catch (error) {
    console.error('Error in test churn detection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// AGE BELLA'S DATA (for STEP 11 testing)
// ============================================
app.post('/api/age-bella-data', async (req, res) => {
  try {
    const bellaId = '550e8400-e29b-41d4-a716-446655440002';

    // Set her last check-in to 8 days ago AND update week_number to an older week
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

    // Get Bella's dog info to calculate what week 8 days ago was
    const { data: bellaInfo } = await supabase
      .from('senior_dogs')
      .select('created_at')
      .eq('id', bellaId)
      .single();

    if (!bellaInfo) throw new Error('Bella not found');

    // Calculate week number for 8 days ago
    const created = new Date(bellaInfo.created_at);
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 8);
    const pastWeek = Math.floor((pastDate - created) / (7 * 24 * 60 * 60 * 1000)) + 1;

    const { error } = await supabase
      .from('mobility_checkins')
      .update({
        created_at: eightDaysAgo.toISOString(),
        week_number: Math.max(1, pastWeek) // Ensure week_number is at least 1
      })
      .eq('dog_id', bellaId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({
      success: true,
      message: `Bella's last check-in aged to week ${Math.max(1, pastWeek)} (${eightDaysAgo.toLocaleDateString()})`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error aging Bella data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// CLEAR BELLA'S CHURN FLAG (for STEP 11 testing)
// ============================================
app.post('/api/clear-bella-alert', async (req, res) => {
  try {
    const bellaId = '550e8400-e29b-41d4-a716-446655440002';

    // Delete Bella's recent churn flags
    const { error } = await supabase
      .from('churn_flags')
      .delete()
      .eq('dog_id', bellaId);

    if (error) throw error;

    res.json({
      success: true,
      message: `Bella's churn flags cleared. She can now be alerted again.`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error clearing Bella alert:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// SEND MAGIC LINK (STEP 19 - Authentication Flow)
// Baseline survey → Magic link token → SMS delivery
// ============================================
app.post('/api/send-magic-link', async (req, res) => {
  try {
    // Extract and validate form data
    const {
      dog_name,
      breed,
      age,
      gender,
      baseline_mobility_getting_up,
      baseline_mobility_stairs,
      baseline_mobility_stiffness_after_rest,
      baseline_mobility_walk_distance,
      baseline_energy_score,
      baseline_appetite_score,
      baseline_cognitive_orientation,
      baseline_cognitive_memory,
      baseline_cognitive_interest,
      baseline_cognitive_sleep_wake,
      observations,
      email,
      phone,
      consent,
      owner_name,
      contact_preference,
      weight_lbs,
      spayed_neutered,
      zip_code,
      diet_type,
      pet_insurance,
      treatment_category,
      medications
    } = req.body;

    // Validate required fields
    if (!dog_name || !breed || !age || !gender || !email || !phone || !consent) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Medications are optional at signup, but if anything was submitted it
    // must all be valid -- reject the whole request rather than silently
    // dropping a bad entry. Staged as JSON on the token (see
    // migration_add_medications.sql) and copied to real medications rows
    // at /verify time, once a real dog_id exists.
    const cleanMedications = cleanMedicationsArray(medications);
    if (cleanMedications === null) {
      return res.status(400).json({
        success: false,
        error: 'One or more medications/supplements has invalid or missing fields'
      });
    }

    // Stage 3: contact_preference replaces the old sms_consent checkbox
    // with a real 3-way choice, matching owners.preferred_contact_method's
    // CHECK constraint exactly.
    if (!['sms', 'email', 'both'].includes(contact_preference)) {
      return res.status(400).json({
        success: false,
        error: 'Please choose how we should contact you (SMS, email, or both)'
      });
    }

    // Sanitize inputs
    // dog_name capped at 40 (tighter than sanitizeName's 100 default) so a
    // long name can't push any SMS template — verification, reminders, the
    // churn email — past a single 160-char GSM-7 segment. See the SMS
    // length audit this cap was added for.
    const cleanName = sanitizeName(dog_name, 40);
    const cleanBreed = sanitizeName(breed);
    // Optional — matches the Stage 3 design decision to not require a
    // human name. Empty string when omitted, not null, matching how the
    // rest of this route already handles optional fields (e.g. observations).
    const cleanOwnerName = owner_name ? sanitizeName(owner_name, 100) : '';
    const cleanAge = parseInt(age);
    const cleanGender = sanitizeSelect(gender, ['male', 'female', 'unknown']);
    const cleanEmail = sanitizeEmail(email);
    const cleanPhone = sanitizePhone(phone);
    const cleanObservations = sanitizeString(observations, 500);

    // STEP P10 instrument: mobility/cognitive are each 4 items, composited
    // server-side via computeCompositeScore(); energy/appetite stay single
    // 0-10 values. isValidInstrumentValue() enforces integer 0-10 for
    // every item — the client-side widget check is UX only, this is the
    // real gate (see docs/Health_Instrument_Redesign_Build.md Stage 1).
    const mobilityItemValues = [
      baseline_mobility_getting_up,
      baseline_mobility_stairs,
      baseline_mobility_stiffness_after_rest,
      baseline_mobility_walk_distance
    ];
    const cognitiveItemValues = [
      baseline_cognitive_orientation,
      baseline_cognitive_memory,
      baseline_cognitive_interest,
      baseline_cognitive_sleep_wake
    ];

    if (mobilityItemValues.some(v => !isValidInstrumentValue(v))) {
      return res.status(400).json({
        success: false,
        error: 'Each mobility item must be a whole number from 0 to 10'
      });
    }
    if (cognitiveItemValues.some(v => !isValidInstrumentValue(v))) {
      return res.status(400).json({
        success: false,
        error: 'Each cognitive item must be a whole number from 0 to 10'
      });
    }
    if (!isValidInstrumentValue(baseline_energy_score)) {
      return res.status(400).json({
        success: false,
        error: 'Energy score must be a whole number from 0 to 10'
      });
    }
    if (!isValidInstrumentValue(baseline_appetite_score)) {
      return res.status(400).json({
        success: false,
        error: 'Appetite score must be a whole number from 0 to 10'
      });
    }

    const cleanMobilityItems = mobilityItemValues.map(Number);
    const cleanCognitiveItems = cognitiveItemValues.map(Number);
    const cleanEnergy = Number(baseline_energy_score);
    const cleanAppetite = Number(baseline_appetite_score);
    // computeCompositeScore() only returns null on an incomplete set, which
    // isValidInstrumentValue() already ruled out above for every item — so
    // these are guaranteed non-null here, but the || null keeps the insert
    // honest if that ever stops being true rather than writing NaN.
    const cleanMobilityComposite = computeCompositeScore(cleanMobilityItems) ?? null;
    const cleanCognitiveComposite = computeCompositeScore(cleanCognitiveItems) ?? null;

    console.log(`📝 Baseline received for ${cleanName}: mobility=${cleanMobilityComposite}, energy=${cleanEnergy}, appetite=${cleanAppetite}, cognitive=${cleanCognitiveComposite}`);

    // Validate parsed values
    if (!cleanName || !cleanBreed || isNaN(cleanAge)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input values'
      });
    }

    // Validate age range
    if (cleanAge < 1 || cleanAge > 30) {
      return res.status(400).json({
        success: false,
        error: 'Age must be between 1 and 30'
      });
    }

    // Validate phone format -- sanitizePhone now rejects both malformed
    // numbers and correctly-formed non-US numbers (including Canada,
    // which Twilio's own account-level Geo Permissions can't separate
    // from the US since both share the +1 country code), so the message
    // needs to cover both real rejection reasons, not just digit count.
    if (!cleanPhone) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid US phone number.'
      });
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email address'
      });
    }

    // ============================================
    // NEW BASELINE FIELDS (weight, spay/neuter, zip,
    // diet, insurance, treatment category)
    // ============================================
    const cleanWeight = parseInt(weight_lbs);
    if (isNaN(cleanWeight) || cleanWeight < 1 || cleanWeight > 250) {
      return res.status(400).json({
        success: false,
        error: 'Weight must be a number between 1 and 250 lbs'
      });
    }

    const cleanSpayedNeutered = sanitizeSelect(spayed_neutered, ['yes', 'no']);
    if (spayed_neutered && !['yes', 'no'].includes(String(spayed_neutered).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Spayed/neutered must be yes or no'
      });
    }

    // US-only gate (Sep 1 2026): the old /^\d{5}$/ only proved "5 numeric
    // digits" -- Germany, France, and several other countries also use
    // 5-digit numeric postal codes, so it never actually distinguished a
    // US ZIP from a foreign one. This isn't a perfect residency check
    // either (a US ZIP alone doesn't prove physical presence, and this
    // still can't tell a US ZIP from Germany's own 5-digit codes) -- see
    // the Build Log for the full investigation and the deliberate call to
    // treat this + the new Terms/Privacy language as sufficient for a
    // 10-person, personally-vetted closed beta rather than build IP
    // geo-blocking or phone country-code validation right now. Accepts
    // ZIP+4 (a genuinely US-specific format nothing else uses) in
    // addition to plain 5-digit, and rejects anything with a letter --
    // which the old regex already did, but is now stated explicitly since
    // that's specifically what would catch a Canadian postal code.
    const cleanZip = typeof zip_code === 'string' ? zip_code.trim() : '';
    if (!/^\d{5}(-\d{4})?$/.test(cleanZip)) {
      return res.status(400).json({
        success: false,
        error: 'ZIP code must be a valid US ZIP code (5 digits, optionally followed by -XXXX)'
      });
    }

    const allowedDietTypes = ['dry', 'wet', 'raw', 'prescription', 'mixed', 'other'];
    const cleanDietType = sanitizeSelect(diet_type, allowedDietTypes);
    if (!diet_type || !allowedDietTypes.includes(String(diet_type).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Diet type must be one of: ' + allowedDietTypes.join(', ')
      });
    }

    const allowedInsuranceValues = ['yes', 'no', 'not_sure'];
    const cleanPetInsurance = sanitizeSelect(pet_insurance, allowedInsuranceValues);
    if (!pet_insurance || !allowedInsuranceValues.includes(String(pet_insurance).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Pet insurance must be one of: ' + allowedInsuranceValues.join(', ')
      });
    }

    const allowedTreatmentCategories = [
      'none', 'joint_supplement', 'nsaid', 'steroid',
      'pain_medication', 'other_prescription', 'other_supplement'
    ];
    const rawTreatmentCategories = Array.isArray(treatment_category)
      ? treatment_category
      : (treatment_category ? [treatment_category] : []);
    const cleanTreatmentCategories = rawTreatmentCategories
      .filter(v => allowedTreatmentCategories.includes(v));

    // Stage 3 returning-owner check: does an owner already exist for this
    // phone number? maybeSingle() (not single()) since the common case —
    // a brand-new signup — has zero matches, which single() would treat
    // as an error rather than a normal "no match" result.
    const { data: existingOwner, error: ownerLookupError } = await supabase
      .from('owners')
      .select('id')
      .eq('phone', cleanPhone)
      .maybeSingle();

    if (ownerLookupError) {
      console.error('Error checking for existing owner:', ownerLookupError);
      return res.status(500).json({
        success: false,
        error: 'Server error. Please try again later.'
      });
    }

    const existingOwnerId = existingOwner ? existingOwner.id : null;

    // Generate a secure random token (32 bytes = 64 hex characters)
    const token = crypto.randomBytes(32).toString('hex');

    // Token expiry: 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store the magic link token in database. Fields below are stored
    // regardless of existingOwnerId (useful for audit/debugging even when
    // unused) — but /verify only trusts them for a brand-new owner. When
    // existingOwnerId is set, /verify pulls contact info from the real
    // owners record instead, never from this resubmitted-but-unverified
    // form data (see Stage 3's design).
    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({
        token,
        email: cleanEmail,
        phone: cleanPhone,
        dog_name: cleanName,
        breed: cleanBreed,
        age: cleanAge,
        gender: cleanGender,
        baseline_mobility_getting_up: cleanMobilityItems[0],
        baseline_mobility_stairs: cleanMobilityItems[1],
        baseline_mobility_stiffness_after_rest: cleanMobilityItems[2],
        baseline_mobility_walk_distance: cleanMobilityItems[3],
        baseline_mobility_score: cleanMobilityComposite,
        baseline_energy_score: cleanEnergy,
        baseline_appetite_score: cleanAppetite,
        baseline_cognitive_orientation: cleanCognitiveItems[0],
        baseline_cognitive_memory: cleanCognitiveItems[1],
        baseline_cognitive_interest: cleanCognitiveItems[2],
        baseline_cognitive_sleep_wake: cleanCognitiveItems[3],
        baseline_cognitive_score: cleanCognitiveComposite,
        observations: cleanObservations,
        // Derived boolean, kept for senior_dogs.sms_consent (still a
        // boolean per Stage 1's mapping) — 'sms' or 'both' count as
        // consenting to SMS, 'email' alone does not.
        sms_consent: contact_preference === 'sms' || contact_preference === 'both',
        contact_preference,
        owner_name: cleanOwnerName || null,
        weight_lbs: cleanWeight,
        spayed_neutered: cleanSpayedNeutered,
        zip_code: cleanZip,
        diet_type: cleanDietType,
        pet_insurance: cleanPetInsurance,
        treatment_category: cleanTreatmentCategories,
        pending_medications: cleanMedications,
        existing_owner_id: existingOwnerId,
        consent_given_at: new Date().toISOString(),
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date().toISOString()
      });

    if (tokenError) {
      console.error('Error storing magic link token:', tokenError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate verification link'
      });
    }

    // Build verification URL
    const verifyUrl = `${BASE_URL}/verify?token=${token}`;

    // Send SMS with magic link via Twilio. Different copy for a returning
    // owner (see Stage 3's design) — the real phone owner should know this
    // adds a dog to an existing account rather than assuming a fresh signup.
    const smsBody = existingOwnerId
      ? `Add ${cleanName} to your account: ${verifyUrl} (15 min)`
      : `${cleanName}'s profile - tap to finish: ${verifyUrl} (15 min)`;

    try {
      const smsMessage = await twilioClient.messages.create({
        body: smsBody,
        from: TWILIO_PHONE_NUMBER,
        to: cleanPhone
      });

      console.log(`✅ Magic link SMS sent to ${cleanPhone} (SID: ${smsMessage.sid})`);
    } catch (smsError) {
      console.error('Error sending magic link SMS:', smsError.message);
      // Note: We could optionally email the link as fallback
      // For now, we'll return an error
      return res.status(500).json({
        success: false,
        error: 'Failed to send verification SMS. Please check your phone number.'
      });
    }

    // Success response
    res.json({
      success: true,
      message: 'Magic link sent! Check your SMS for a verification link.',
      phone: cleanPhone,
      existingOwner: !!existingOwnerId
    });

  } catch (error) {
    console.error('Error in send-magic-link endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Server error. Please try again later.'
    });
  }
});

// ============================================
// VERIFY MAGIC LINK (STEP 20 - Profile Creation)
// Validates token, creates senior_dogs profile, redirects to dashboard
// ============================================
app.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    // Validate token parameter
    if (!token) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Verification Failed | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Invalid Link</h1>
              <p>This verification link is missing or invalid. Please start your Baseline Health Journey again.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Fetch the magic link token from database
    const { data: tokenData, error: fetchError } = await supabase
      .from('magic_link_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (fetchError || !tokenData) {
      console.log('Magic link token not found:', token);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Not Found | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Link Not Found</h1>
              <p>This verification link doesn't exist. Please request a new one by completing the Baseline Health Journey.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Check if token has already been used
    if (tokenData.used_at) {
      console.log('Magic link token already used:', token);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Already Used | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Link Already Used</h1>
              <p>This verification link has already been used. If you need a new one, complete the Baseline Health Journey again.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Check if token has expired
    const expiresAt = new Date(tokenData.expires_at);
    if (expiresAt < new Date()) {
      console.log('Magic link token expired:', token);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Expired | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1><i data-lucide="clock"></i> Link Expired</h1>
              <p>This verification link expired after 15 minutes. Complete the Baseline Health Journey again to get a new link.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
            <script src="https://unpkg.com/lucide@1.33.0"></script>
            <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
          </body>
        </html>
      `);
    }

    // Token is valid! Resolve the owner first — either link to the
    // existing one (Stage 3's returning-owner path) or create a brand-new
    // one. Either way, phone/email/zip for the new senior_dogs row below
    // come from this resolved owner, never straight from tokenData, so a
    // returning owner's dog is always tied to their real, trusted contact
    // info rather than whatever was resubmitted (and not yet verified) on
    // this particular form.
    const now = new Date().toISOString();
    let ownerId, ownerPhone, ownerEmail, ownerZip, ownerSmsConsent;

    if (tokenData.existing_owner_id) {
      const { data: existingOwnerRow, error: existingOwnerError } = await supabase
        .from('owners')
        .select('id, email, phone, zip_code, preferred_contact_method')
        .eq('id', tokenData.existing_owner_id)
        .single();

      if (existingOwnerError || !existingOwnerRow) {
        console.error('Error fetching existing owner for verify:', existingOwnerError);
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Error | Companion Commons</title>
              <style>
                body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 50px auto; text-align: center; padding: 20px; }
                .error-box { background: #fee; border-radius: 12px; padding: 30px; }
                h1 { color: #c33; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>❌ Error Creating Profile</h1>
                <p>Something went wrong finding your account. Please contact support or try again later.</p>
              </div>
            </body>
          </html>
        `);
      }

      ownerId = existingOwnerRow.id;
      ownerPhone = existingOwnerRow.phone;
      ownerEmail = existingOwnerRow.email;
      ownerZip = existingOwnerRow.zip_code;
      ownerSmsConsent = existingOwnerRow.preferred_contact_method === 'sms' || existingOwnerRow.preferred_contact_method === 'both';
    } else {
      const { data: newOwner, error: newOwnerError } = await supabase
        .from('owners')
        .insert({
          email: tokenData.email,
          phone: tokenData.phone,
          preferred_contact_method: tokenData.contact_preference,
          zip_code: tokenData.zip_code,
          name: tokenData.owner_name || null,
          preferred_reminder_day: 3,        // Wednesday (mid-week, neutral) — same default senior_dogs uses below
          preferred_reminder_time: '14:00', // 2:00 PM (afternoon, safe for all)
          created_at: now
        })
        .select()
        .single();

      if (newOwnerError || !newOwner) {
        console.error('Error creating owner:', newOwnerError);
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Error | Companion Commons</title>
              <style>
                body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 50px auto; text-align: center; padding: 20px; }
                .error-box { background: #fee; border-radius: 12px; padding: 30px; }
                h1 { color: #c33; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>❌ Error Creating Profile</h1>
                <p>Something went wrong. Please contact support or try again later.</p>
              </div>
            </body>
          </html>
        `);
      }

      ownerId = newOwner.id;
      ownerPhone = tokenData.phone;
      ownerEmail = tokenData.email;
      ownerZip = tokenData.zip_code;
      ownerSmsConsent = tokenData.sms_consent === true || tokenData.sms_consent === 'true';
    }

    const { data: newDog, error: dogError } = await supabase
      .from('senior_dogs')
      .insert({
        dog_name: tokenData.dog_name,
        breed: tokenData.breed,
        age: tokenData.age,
        gender: tokenData.gender,
        baseline_mobility_getting_up: tokenData.baseline_mobility_getting_up,
        baseline_mobility_stairs: tokenData.baseline_mobility_stairs,
        baseline_mobility_stiffness_after_rest: tokenData.baseline_mobility_stiffness_after_rest,
        baseline_mobility_walk_distance: tokenData.baseline_mobility_walk_distance,
        baseline_mobility_score: tokenData.baseline_mobility_score,
        baseline_energy_score: tokenData.baseline_energy_score,
        baseline_appetite_score: tokenData.baseline_appetite_score,
        baseline_cognitive_orientation: tokenData.baseline_cognitive_orientation,
        baseline_cognitive_memory: tokenData.baseline_cognitive_memory,
        baseline_cognitive_interest: tokenData.baseline_cognitive_interest,
        baseline_cognitive_sleep_wake: tokenData.baseline_cognitive_sleep_wake,
        baseline_cognitive_score: tokenData.baseline_cognitive_score,
        baseline_notes: tokenData.observations,
        phone: ownerPhone,
        email: ownerEmail,
        sms_consent: ownerSmsConsent,
        weight_lbs: tokenData.weight_lbs,
        spayed_neutered: tokenData.spayed_neutered,
        zip_code: ownerZip,
        diet_type: tokenData.diet_type,
        pet_insurance: tokenData.pet_insurance,
        treatment_category: tokenData.treatment_category,
        owner_id: ownerId,
        consent_given_at: tokenData.consent_given_at,
        created_at: now,
        preferred_reminder_day: 3,        // Wednesday (mid-week, neutral)
        preferred_reminder_time: '14:00'  // 2:00 PM (afternoon, safe for all)
      })
      .select();

    if (dogError || !newDog || newDog.length === 0) {
      console.error('Error creating senior_dog profile:', dogError);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Error | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Error Creating Profile</h1>
              <p>Something went wrong. Please contact support or try again later.</p>
            </div>
          </body>
        </html>
      `);
    }

    const dogId = newDog[0].id;

    // Copy staged baseline medications (see migration_add_medications.sql)
    // into real medications rows now that a real dog_id exists. Re-cleaned
    // here, not just trusted from the token — defense in depth, same
    // "validate at every boundary" pattern already used for every other
    // baseline field on this route. Non-fatal on failure: losing a
    // medication entry shouldn't block the whole signup/redirect, the
    // same reasoning already applied to the Sheets export below.
    const pendingMeds = cleanMedicationsArray(tokenData.pending_medications) || [];
    if (pendingMeds.length > 0) {
      const { error: medsInsertError } = await supabase
        .from('medications')
        .insert(pendingMeds.map(m => ({ dog_id: dogId, ...m })));
      if (medsInsertError) {
        console.error(`❌ Error inserting baseline medications for dog ${dogId}:`, medsInsertError.message);
      }
    }

    // Mark the token as used
    const { error: updateError } = await supabase
      .from('magic_link_tokens')
      .update({ used_at: now })
      .eq('token', token);

    if (updateError) {
      console.error('Error marking token as used:', updateError);
      // Non-fatal - continue to redirect
    }

    console.log(`✅ Profile created for ${tokenData.dog_name} (ID: ${dogId})`);

    // Export to Google Sheets (Signups tab) — real signup + baseline data,
    // fired after everything above is confirmed successful. Doesn't block
    // or affect the redirect either way if this fails.
    // Dog ID is the real join key across all three tabs — dog names aren't
    // unique (two people can both name their dog "Max"), and email isn't a
    // reliable per-dog key either. This is the same UUID already used
    // throughout the app itself (dashboard/check-in URLs).
    await appendRowToSheet('Signups', [
      new Date().toISOString(),
      dogId,
      ownerEmail || '',
      tokenData.dog_name || '',
      tokenData.breed || '',
      tokenData.age || '',
      tokenData.gender || '',
      tokenData.weight_lbs ?? '',
      tokenData.baseline_mobility_score ?? '',
      tokenData.baseline_energy_score ?? '',
      tokenData.baseline_appetite_score ?? '',
      tokenData.baseline_cognitive_score ?? '',
      // Resolved owner fields (ownerPhone/ownerZip), not tokenData.phone/
      // zip_code directly — on the returning-owner path those must come
      // from the real owner record, never the resubmitted form, same
      // security reasoning already applied to the senior_dogs insert above.
      ...buildSignupSheetsExtraColumns({
        phone: ownerPhone,
        zipCode: ownerZip,
        spayedNeutered: tokenData.spayed_neutered,
        dietType: tokenData.diet_type,
        petInsurance: tokenData.pet_insurance,
        treatmentCategories: tokenData.treatment_category,
        smsConsent: ownerSmsConsent,
        consentGivenAt: tokenData.consent_given_at
      })
    ]);

    // STAGE 5: grant the additive owner-session cookie here — this is the
    // one point in the whole app where the browser has just proven real
    // phone ownership (a valid, unexpired, single-use magic-link click),
    // covering both the new-owner and returning-owner branches above since
    // ownerId is resolved either way by this point. See the OWNER SESSION
    // block near the top of this file for what this cookie does and does
    // not do.
    setOwnerSessionCookie(res, ownerId);

    // Redirect to dashboard with the new dog ID
    res.redirect(`/dashboard/${dogId}`);

  } catch (error) {
    console.error('Error in verify endpoint:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Error | Companion Commons</title>
          <style>
            body {
              font-family: -apple-system, sans-serif;
              max-width: 500px;
              margin: 50px auto;
              text-align: center;
              padding: 20px;
            }
            .error-box {
              background: #fee;
              border-radius: 12px;
              padding: 30px;
            }
            h1 {
              color: #c33;
            }
          </style>
        </head>
        <body>
          <div class="error-box">
            <h1>❌ Server Error</h1>
            <p>An unexpected error occurred. Please try again later.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// ============================================
// ADD ANOTHER DOG (Stage 3 — multi-dog owner project)
// Phase-B-only creation for an already-known owner. No magic-link/SMS
// step here — reached from a link the owner only sees after already
// verifying their phone once (on the post-verification confirmation page
// or dashboard), so re-verifying again would be redundant friction, not
// extra safety. See Stage 3's design for the reasoning.
// ============================================
app.post('/api/add-dog', async (req, res) => {
  try {
    const {
      owner_id,
      dog_name,
      breed,
      age,
      gender,
      baseline_mobility_getting_up,
      baseline_mobility_stairs,
      baseline_mobility_stiffness_after_rest,
      baseline_mobility_walk_distance,
      baseline_energy_score,
      baseline_appetite_score,
      baseline_cognitive_orientation,
      baseline_cognitive_memory,
      baseline_cognitive_interest,
      baseline_cognitive_sleep_wake,
      observations,
      consent,
      weight_lbs,
      spayed_neutered,
      diet_type,
      pet_insurance,
      treatment_category,
      medications
    } = req.body;

    if (!owner_id || !dog_name || !breed || !age || !gender || !consent) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Medications are optional, but if anything was submitted it must all
    // be valid — reject the whole request rather than silently dropping a
    // bad entry. This route creates the dog synchronously (no token
    // staging step needed, unlike /verify), so real medications rows are
    // inserted directly below once dogId exists.
    const cleanMedications = cleanMedicationsArray(medications);
    if (cleanMedications === null) {
      return res.status(400).json({
        success: false,
        error: 'One or more medications/supplements has invalid or missing fields'
      });
    }

    // Confirm the owner is real before creating anything against it.
    const { data: owner, error: ownerError } = await supabase
      .from('owners')
      .select('id, email, phone, zip_code, preferred_contact_method')
      .eq('id', owner_id)
      .maybeSingle();

    if (ownerError) {
      console.error('Error looking up owner for add-dog:', ownerError);
      return res.status(500).json({ success: false, error: 'Server error. Please try again later.' });
    }

    if (!owner) {
      return res.status(404).json({ success: false, error: 'We could not find your account. Please use the link from your confirmation page, or start a new signup.' });
    }

    // Same 40-char cap as the main signup route, for the same reason (SMS
    // segment length across every template that interpolates dog_name).
    const cleanName = sanitizeName(dog_name, 40);
    const cleanBreed = sanitizeName(breed);
    const cleanAge = parseInt(age);
    const cleanGender = sanitizeSelect(gender, ['male', 'female', 'unknown']);
    const cleanObservations = sanitizeString(observations, 500);

    // STEP P10 instrument — same validation shape as /api/send-magic-link.
    // Duplicated here rather than shared because this route independently
    // re-implements the whole validation+insert path (no magic-link token
    // staging step) — same duplication the old 1-8 version already had.
    const mobilityItemValues = [
      baseline_mobility_getting_up,
      baseline_mobility_stairs,
      baseline_mobility_stiffness_after_rest,
      baseline_mobility_walk_distance
    ];
    const cognitiveItemValues = [
      baseline_cognitive_orientation,
      baseline_cognitive_memory,
      baseline_cognitive_interest,
      baseline_cognitive_sleep_wake
    ];

    if (mobilityItemValues.some(v => !isValidInstrumentValue(v))) {
      return res.status(400).json({ success: false, error: 'Each mobility item must be a whole number from 0 to 10' });
    }
    if (cognitiveItemValues.some(v => !isValidInstrumentValue(v))) {
      return res.status(400).json({ success: false, error: 'Each cognitive item must be a whole number from 0 to 10' });
    }
    if (!isValidInstrumentValue(baseline_energy_score)) {
      return res.status(400).json({ success: false, error: 'Energy score must be a whole number from 0 to 10' });
    }
    if (!isValidInstrumentValue(baseline_appetite_score)) {
      return res.status(400).json({ success: false, error: 'Appetite score must be a whole number from 0 to 10' });
    }

    const cleanMobilityItems = mobilityItemValues.map(Number);
    const cleanCognitiveItems = cognitiveItemValues.map(Number);
    const cleanEnergy = Number(baseline_energy_score);
    const cleanAppetite = Number(baseline_appetite_score);
    const cleanMobilityComposite = computeCompositeScore(cleanMobilityItems) ?? null;
    const cleanCognitiveComposite = computeCompositeScore(cleanCognitiveItems) ?? null;

    if (!cleanName || !cleanBreed || isNaN(cleanAge)) {
      return res.status(400).json({ success: false, error: 'Invalid input values' });
    }

    if (cleanAge < 1 || cleanAge > 30) {
      return res.status(400).json({ success: false, error: 'Age must be between 1 and 30' });
    }

    const cleanWeight = parseInt(weight_lbs);
    if (isNaN(cleanWeight) || cleanWeight < 1 || cleanWeight > 250) {
      return res.status(400).json({ success: false, error: 'Weight must be a number between 1 and 250 lbs' });
    }

    const cleanSpayedNeutered = sanitizeSelect(spayed_neutered, ['yes', 'no']);
    if (spayed_neutered && !['yes', 'no'].includes(String(spayed_neutered).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Spayed/neutered must be yes or no' });
    }

    const allowedDietTypes = ['dry', 'wet', 'raw', 'prescription', 'mixed', 'other'];
    const cleanDietType = sanitizeSelect(diet_type, allowedDietTypes);
    if (!diet_type || !allowedDietTypes.includes(String(diet_type).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Diet type must be one of: ' + allowedDietTypes.join(', ') });
    }

    const allowedInsuranceValues = ['yes', 'no', 'not_sure'];
    const cleanPetInsurance = sanitizeSelect(pet_insurance, allowedInsuranceValues);
    if (!pet_insurance || !allowedInsuranceValues.includes(String(pet_insurance).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Pet insurance must be one of: ' + allowedInsuranceValues.join(', ') });
    }

    const allowedTreatmentCategories = [
      'none', 'joint_supplement', 'nsaid', 'steroid',
      'pain_medication', 'other_prescription', 'other_supplement'
    ];
    const rawTreatmentCategories = Array.isArray(treatment_category)
      ? treatment_category
      : (treatment_category ? [treatment_category] : []);
    const cleanTreatmentCategories = rawTreatmentCategories
      .filter(v => allowedTreatmentCategories.includes(v));

    const now = new Date().toISOString();
    const ownerSmsConsent = owner.preferred_contact_method === 'sms' || owner.preferred_contact_method === 'both';

    const { data: newDog, error: dogError } = await supabase
      .from('senior_dogs')
      .insert({
        dog_name: cleanName,
        breed: cleanBreed,
        age: cleanAge,
        gender: cleanGender,
        baseline_mobility_getting_up: cleanMobilityItems[0],
        baseline_mobility_stairs: cleanMobilityItems[1],
        baseline_mobility_stiffness_after_rest: cleanMobilityItems[2],
        baseline_mobility_walk_distance: cleanMobilityItems[3],
        baseline_mobility_score: cleanMobilityComposite,
        baseline_energy_score: cleanEnergy,
        baseline_appetite_score: cleanAppetite,
        baseline_cognitive_orientation: cleanCognitiveItems[0],
        baseline_cognitive_memory: cleanCognitiveItems[1],
        baseline_cognitive_interest: cleanCognitiveItems[2],
        baseline_cognitive_sleep_wake: cleanCognitiveItems[3],
        baseline_cognitive_score: cleanCognitiveComposite,
        baseline_notes: cleanObservations,
        phone: owner.phone,
        email: owner.email,
        sms_consent: ownerSmsConsent,
        weight_lbs: cleanWeight,
        spayed_neutered: cleanSpayedNeutered,
        zip_code: owner.zip_code,
        diet_type: cleanDietType,
        pet_insurance: cleanPetInsurance,
        treatment_category: cleanTreatmentCategories,
        owner_id: owner.id,
        consent_given_at: now,
        created_at: now,
        preferred_reminder_day: 3,
        preferred_reminder_time: '14:00'
      })
      .select();

    if (dogError || !newDog || newDog.length === 0) {
      console.error('Error creating senior_dog profile via add-dog:', dogError);
      return res.status(500).json({ success: false, error: 'Something went wrong creating the profile. Please try again later.' });
    }

    const dogId = newDog[0].id;
    console.log(`✅ Profile created via add-dog for ${cleanName} (ID: ${dogId}, owner: ${owner.id})`);

    // No staging needed on this route (dog already exists) -- insert real
    // medications rows directly. Non-fatal on failure, same reasoning as
    // /verify's equivalent step.
    if (cleanMedications.length > 0) {
      const { error: medsInsertError } = await supabase
        .from('medications')
        .insert(cleanMedications.map(m => ({ dog_id: dogId, ...m })));
      if (medsInsertError) {
        console.error(`❌ Error inserting baseline medications for dog ${dogId}:`, medsInsertError.message);
      }
    }

    // Same Signups tab, same join key (dog UUID) as the main signup route.
    await appendRowToSheet('Signups', [
      new Date().toISOString(),
      dogId,
      owner.email || '',
      cleanName,
      cleanBreed,
      cleanAge,
      cleanGender,
      cleanWeight ?? '',
      cleanMobilityComposite ?? '',
      cleanEnergy ?? '',
      cleanAppetite ?? '',
      cleanCognitiveComposite ?? '',
      ...buildSignupSheetsExtraColumns({
        phone: owner.phone,
        zipCode: owner.zip_code,
        spayedNeutered: cleanSpayedNeutered,
        dietType: cleanDietType,
        petInsurance: cleanPetInsurance,
        treatmentCategories: cleanTreatmentCategories,
        smsConsent: ownerSmsConsent,
        consentGivenAt: now
      })
    ]);

    // STAGE 5: this path is only reachable from a link the owner already
    // holds (dashboard's "+ Add Another Dog"), so grant/refresh the same
    // additive session cookie here too — belt-and-suspenders alongside the
    // /verify grant point, not a second distinct mechanism.
    setOwnerSessionCookie(res, owner.id);

    res.json({ success: true, dogId });
  } catch (error) {
    console.error('Error in add-dog endpoint:', error);
    res.status(500).json({ success: false, error: 'Server error. Please try again later.' });
  }
});

// ============================================
// ALL MY DOGS' CHECK-INS (STAGE 4 — multi-dog owner project)
// GET /checkins/:owner_id
//
// A single, no-login landing page listing every dog belonging to one
// owner, each with its own check-in status and link. This is the page the
// new combined SMS reminder/churn email link to, so an owner with several
// dogs due at once gets ONE short link instead of one text per dog. Not
// authenticated — matches the app's existing link-based security model
// (same as /check-in/:dog_id and /dashboard/:dog_id, both reachable by
// anyone with the right UUID in the URL). This is deliberately NOT the
// full owner session/dog-switcher from Stage 5 — no login, no cookie, just
// a status list keyed off the owner_id already in hand.
// ============================================
app.get('/checkins/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;

    const { data: dogs, error } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, photo_url, created_at')
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: true });

    if (error || !dogs || dogs.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Not Found</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          </style>
        </head>
        <body>
          <div class="card">
            <h2 style="margin: 0 0 10px 0;">We couldn't find that account</h2>
            <p style="color: #666;">Please check your link, or use the one from your most recent text or email.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Same week/status math used by /check-in/:dog_id and the dashboard —
    // computed fresh per dog, not stored, so it's always current.
    const now = new Date();
    const { data: allCheckins } = await supabase
      .from('mobility_checkins')
      .select('dog_id, week_number')
      .in('dog_id', dogs.map(d => d.id));

    const dogRows = dogs.map(dog => {
      const created = new Date(dog.created_at);
      const daysSinceSignup = (now - created) / (24 * 60 * 60 * 1000);
      const inBaselinePeriod = Math.floor(daysSinceSignup / 7) === 0;
      const currentWeek = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);
      const hasCheckinThisWeek = (allCheckins || []).some(c => c.dog_id === dog.id && c.week_number === currentWeek);

      let statusText, actionHtml;
      if (inBaselinePeriod) {
        const daysLeft = 7 - Math.floor(daysSinceSignup);
        statusText = `First check-in available in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
        actionHtml = `<span style="color: #999; font-size: 14px;">Not yet available</span>`;
      } else if (hasCheckinThisWeek) {
        statusText = `Week ${currentWeek} — already checked in ✓`;
        actionHtml = `<a href="/dashboard/${dog.id}" style="color: #d96f56; font-weight: 600; text-decoration: none; font-size: 14px;">View Dashboard →</a>`;
      } else {
        statusText = `Week ${currentWeek} check-in is ready`;
        actionHtml = `<a href="/check-in/${dog.id}" style="display: inline-block; background: #d96f56; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Check In Now</a>`;
      }

      const photoHtml = dog.photo_url
        ? `<img src="${dog.photo_url}" alt="${escapeHtml(dog.dog_name)}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover; flex-shrink: 0;" />`
        : `<div style="width: 56px; height: 56px; border-radius: 50%; background: #FFF8E7; flex-shrink: 0;"></div>`;

      return `
        <div style="display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid #eee;">
          ${photoHtml}
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #333;">${escapeHtml(dog.dog_name)}</div>
            <div style="font-size: 13px; color: #777; margin-top: 2px;">${statusText}</div>
          </div>
          ${actionHtml}
        </div>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Your Dogs' Check-Ins</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
          .card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          h2 { margin: 0 0 4px 0; color: #333; }
          .subtitle { color: #666; margin: 0 0 8px 0; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Your Dogs' Check-Ins</h2>
          <p class="subtitle">${dogs.length} dog${dogs.length === 1 ? '' : 's'} on your account</p>
          ${dogRows}
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error rendering /checkins/:owner_id:', error);
    res.status(500).send('Something went wrong loading your dogs. Please try again later.');
  }
});

// Email version of the dashboard-link resend below — same visual pattern
// as sendChurnAlertEmail, sent to the owner's real email on file (never
// whatever address a resubmitted form claims, since this route only ever
// looks up contact info from the verified owners record).
async function sendDashboardLinkEmail(ownerEmail, checkinsLink) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return;
  }

  try {
    const msg = {
      to: ownerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: `Your Companion Commons dashboard link`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Here's your link 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              You (or someone with your phone number) asked for your Companion Commons dashboard link. Tap below to see your dog's (or dogs') health journey.
            </p>
            <div style="text-align: center; margin-top: 25px;">
              <a href="${checkinsLink}" style="display: inline-block; background: #d96f56; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                View My Dashboard
              </a>
            </div>
            <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
              Didn't request this? You can safely ignore this email.
            </p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Dashboard-link email sent to ${ownerEmail}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending dashboard-link email to ${ownerEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// EMAIL UNSUBSCRIBE
// GET /unsubscribe/:owner_id
//
// Closes a real gap: faqs.html/privacy.html both promise email unsubscribe,
// but nothing implemented it (SMS "Reply STOP" already works correctly via
// Twilio and is unaffected by this). One click, no login -- the standard
// pattern for any real unsubscribe link (deliberately a state-changing GET,
// the accepted exception to that usual rule for exactly this use case).
//
// Keyed on the bare owner_id, same trust model already used by
// /checkins/:owner_id and /dashboard/:dog_id -- a 122-bit random UUID,
// not a separate expiring token. Deliberately NOT reusing the
// magic_link_tokens mechanism (random token + 15-min expiry + single-use):
// an unsubscribe link needs to stay valid indefinitely and be safely
// re-clickable, the opposite of what that mechanism is built for.
//
// Idempotent -- clicking an already-processed link just re-shows the same
// confirmation, no error.
// ============================================
app.get('/unsubscribe/:owner_id', async (req, res) => {
  const { owner_id } = req.params;

  const { data: owner, error } = await supabase
    .from('owners')
    .select('id')
    .eq('id', owner_id)
    .single();

  if (error || !owner) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Not Found | Companion Commons</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; background: #f5f5f5; }
          .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="margin: 0 0 10px 0;">We couldn't find that account</h2>
          <p style="color: #666;">Please check the link from your email, or use our <a href="/contact.html">contact form</a> if you need help.</p>
        </div>
      </body>
      </html>
    `);
  }

  const { error: updateError } = await supabase
    .from('owners')
    .update({ email_opt_out: true })
    .eq('id', owner_id);

  if (updateError) {
    console.error(`❌ Error setting email_opt_out for owner ${owner_id}:`, updateError.message);
    return res.status(500).send('Something went wrong. Please try again or contact us directly.');
  }

  console.log(`✅ Owner ${owner_id} unsubscribed from email reminders`);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Unsubscribed | Companion Commons</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; background: #f5f5f5; }
        .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        a { color: #d96f56; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin: 0 0 10px 0;">You've been unsubscribed</h2>
        <p style="color: #666; line-height: 1.6;">
          You've been unsubscribed from email reminders — you'll still receive SMS reminders unless you also reply STOP to those.
        </p>
        <p style="color: #999; font-size: 13px; margin-top: 24px;">
          Changed your mind, or have a question? <a href="/contact.html">Contact us</a>.
        </p>
      </div>
    </body>
    </html>
  `);
});

// ============================================
// SELF-SERVICE "RESEND MY DASHBOARD LINK"
// POST /api/resend-dashboard-link
//
// Closes a real gap: once someone loses the original signup link (deletes
// the SMS, clears history), there was no way back into a page (the
// dashboard) that's supposed to be viewable/printable/shareable any time —
// short of waiting for a reminder text to fire incidentally.
//
// Security posture, deliberate throughout: this endpoint must never reveal
// whether a given phone number or email has an account. Every code path —
// owner found and message sent, owner not found, invalid input, or
// rate-limited — returns the exact same generic response text. The real
// outcome is only ever visible server-side via console.log.
//
// Timing side-channel fix (found via a real full-site security audit,
// confirmed empirically: registered numbers averaged 378ms, unregistered
// averaged 146ms, zero overlap): the actual Twilio/SendGrid send used to be
// awaited before responding, so a found owner's request always took
// measurably longer than a not-found one, regardless of the identical
// response body. Fixed by responding immediately after the (fast) owner
// lookup and running the actual send fire-and-forget afterward — every path
// now responds at the same speed. This doesn't lose any user-facing error
// signal that didn't already not exist: a send failure was already
// swallowed into the same generic response even when awaited (see the
// catch blocks below), so the client was never told about a send failure
// either way. The `responded` guard below makes this safe even if something
// unexpected throws after the response is sent (logged via the outer catch,
// never a second res.json() call).
// ============================================
app.post('/api/resend-dashboard-link', async (req, res) => {
  const GENERIC_RESPONSE = { success: true, message: "If that number has an account, we've sent a link." };
  let responded = false;
  const respond = () => {
    if (!responded) {
      responded = true;
      res.json(GENERIC_RESPONSE);
    }
  };

  try {
    // Anti-enumeration limiter, checked first, before even validating input
    // shape — separate from the generic apiRateLimit (10 req/10sec/IP,
    // applied to all POST routes, far too loose for this specific lookup)
    // and separate from perContactRateLimit below (which only limits
    // repeats to the same already-known phone/email, not breadth across
    // many different candidates from one source).
    const ip = req.ip || req.connection.remoteAddress;
    const ipLimitResult = resendLookupIpRateLimit(ip);
    if (!ipLimitResult.allowed) {
      console.log(`⏭️ resend-dashboard-link: IP rate limited for ${ip}`);
      return respond();
    }

    const { phone, email } = req.body;
    // Same normalization used at signup (/api/send-magic-link) — reused
    // as-is rather than re-implemented, so "what counts as a valid
    // phone/email" can't quietly drift between the two routes. Phone wins
    // if both are somehow present, matching its role elsewhere in the app
    // as the primary identifier.
    const cleanPhone = phone ? sanitizePhone(phone) : null;
    const cleanEmail = (!cleanPhone && email) ? sanitizeEmail(email) : null;
    const identifier = cleanPhone || cleanEmail;

    if (!identifier) {
      console.log('ℹ️ resend-dashboard-link: invalid/unparseable phone or email submitted');
      return respond();
    }

    // Rate limit keyed by the identifier itself, not IP — this is the same
    // perContactRateLimit() used for both phone and email, protecting one
    // real contact from repeated sends regardless of which channel it is.
    const rateLimitResult = perContactRateLimit(identifier);
    if (!rateLimitResult.allowed) {
      console.log(`⏭️ resend-dashboard-link: rate limited for ${identifier}`);
      return respond();
    }

    const ownerLookup = cleanPhone
      ? supabase.from('owners').select('id, email, phone, preferred_contact_method').eq('phone', cleanPhone).maybeSingle()
      : supabase.from('owners').select('id, email, phone, preferred_contact_method').eq('email', cleanEmail).maybeSingle();
    const { data: owner, error: ownerError } = await ownerLookup;

    if (ownerError) {
      console.error('Error looking up owner for resend-dashboard-link:', ownerError);
      return respond();
    }

    if (!owner) {
      console.log(`ℹ️ resend-dashboard-link: no owner found for ${identifier}`);
      return respond();
    }

    // Respond now — everything below runs fire-and-forget and must never
    // touch `res` again (see the security-posture comment above).
    respond();

    // Reuses the existing /checkins/:owner_id page as-is — it already
    // lists every one of the owner's dogs with status and a dashboard link
    // each, so there's nothing new to build here.
    const checkinsLink = `${BASE_URL}/checkins/${owner.id}`;
    const wantsSms = owner.preferred_contact_method === 'sms' || owner.preferred_contact_method === 'both';
    const wantsEmail = owner.preferred_contact_method === 'email' || owner.preferred_contact_method === 'both';

    if (wantsSms && owner.phone) {
      try {
        const smsMessage = await twilioClient.messages.create({
          body: `Your Companion Commons dashboard link: ${checkinsLink}`,
          from: TWILIO_PHONE_NUMBER,
          to: owner.phone
        });
        console.log(`✅ resend-dashboard-link SMS sent to ${owner.phone} (SID: ${smsMessage.sid})`);
      } catch (smsError) {
        console.error(`❌ resend-dashboard-link SMS failed for ${owner.phone}:`, smsError.message);
      }
    }

    if (wantsEmail && owner.email) {
      const emailResult = await sendDashboardLinkEmail(owner.email, checkinsLink);
      if (!emailResult || !emailResult.success) {
        console.error(`❌ resend-dashboard-link email failed for ${owner.email}`);
      }
    }
  } catch (error) {
    // Still the same generic response even on an unexpected server error —
    // no path through this endpoint should ever look different from any
    // other to the client. Safe no-op if already responded (see `respond`).
    console.error('Error in resend-dashboard-link endpoint:', error);
    respond();
  }
});

// ============================================
// CONTACT US
// POST /api/contact
//
// Public-facing form (contact.html) -- no owner lookup, so none of
// resend-dashboard-link's enumeration/timing concerns apply here. Two
// distinct anti-abuse layers, both required to silently return the exact
// same generic success response as a real submission: a honeypot field
// (bots that auto-fill every input trip it; real users never see it) and
// contactFormIpRateLimit above. A genuine validation error (missing/
// malformed email, empty message) is NOT disguised -- that's normal form
// feedback for a real user, not a security boundary, so it gets a real
// 400 with a real message, same as every other form on this site.
// ============================================

const GENERIC_CONTACT_RESPONSE = { success: true, message: "Thanks for reaching out — we'll be in touch within 48 hours." };

// Internal notification, sent to hello@ (a real, Porkbun-forwarded address
// John already checks -- confirmed before building this, not assumed).
// replyTo is set to the submitter's own address so replying to this email
// in any normal mail client goes straight back to them, no copy-paste.
async function sendContactNotificationEmail(submitterEmail, message, submittedAt) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return { success: false, error: 'SendGrid not configured' };
  }

  try {
    const emailSafe = escapeHtml(submitterEmail);
    const messageSafe = escapeHtml(message);
    const dateStr = submittedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

    const msg = {
      to: 'hello@companioncommons.com',
      from: SENDGRID_FROM_EMAIL,
      replyTo: submitterEmail,
      subject: 'New message via Contact Us',
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">New Contact Us message</h2>
            <p style="color: #666; font-size: 14px; margin: 0 0 4px 0;"><strong>From:</strong> ${emailSafe}</p>
            <p style="color: #666; font-size: 14px; margin: 0 0 20px 0;"><strong>Submitted:</strong> ${dateStr}</p>
            <div style="background: #fff; border-radius: 8px; padding: 20px; white-space: pre-wrap; color: #333; font-size: 15px; line-height: 1.6;">${messageSafe}</div>
            <p style="color: #999; font-size: 12px; margin-top: 24px; text-align: center;">Reply directly to this email to respond to ${emailSafe}.</p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Contact notification email sent to hello@companioncommons.com (from ${submitterEmail})`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending contact notification email for ${submitterEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Confirmation copy sent back to the submitter, same warm visual pattern
// (card, wave emoji, muted footer tagline) as sendDashboardLinkEmail /
// sendChurnAlertEmail. The 48-hour response-time promise matches the one
// already stated on privacy.html, not a new number invented here.
async function sendContactConfirmationEmail(submitterEmail, message) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return { success: false, error: 'SendGrid not configured' };
  }

  try {
    const messageSafe = escapeHtml(message);

    const msg = {
      to: submitterEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: 'We got your message 👋',
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Thanks for reaching out! 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              We received your message and will get back to you within 48 hours.
            </p>
            <p style="color: #666; font-size: 14px; margin: 20px 0 8px 0;">Here's a copy of what you sent:</p>
            <div style="background: #fff; border-radius: 8px; padding: 20px; white-space: pre-wrap; color: #333; font-size: 15px; line-height: 1.6;">${messageSafe}</div>
            <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
              Companion Commons — Together we can change the future of pet health understanding
            </p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Contact confirmation email sent to ${submitterEmail}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending contact confirmation email to ${submitterEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}

app.post('/api/contact', async (req, res) => {
  try {
    // IP rate limit, checked first, before any input validation -- same
    // ordering as resendLookupIpRateLimit's usage above.
    const ip = req.ip || req.connection.remoteAddress;
    const ipLimitResult = contactFormIpRateLimit(ip);
    if (!ipLimitResult.allowed) {
      console.log(`⏭️ contact form: IP rate limited for ${ip}`);
      return res.json(GENERIC_CONTACT_RESPONSE);
    }

    // Honeypot: a real user never sees or fills this field (hidden
    // off-screen in contact.html, not type="hidden" -- some bots skip
    // type="hidden" specifically, off-screen positioning is harder to
    // detect without actually rendering the page). Any non-empty value
    // here means a bot filled every field it could find. Reject silently
    // with the exact same response a real submission gets -- a bot (or
    // whoever's watching its output) learns nothing from the difference.
    const honeypot = req.body.website;
    if (honeypot) {
      console.log(`⏭️ contact form: honeypot tripped for IP ${ip}`);
      return res.json(GENERIC_CONTACT_RESPONSE);
    }

    // Real validation below IS user-facing (real 400s) -- this isn't a
    // security boundary like the honeypot/rate-limit checks above, just
    // normal form feedback.
    const cleanEmail = sanitizeEmail(req.body.email);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    // 2000 chars, not the 500 used for check-in observations elsewhere --
    // a contact message is a different use case (describing an issue,
    // giving feedback) and reasonably needs more room.
    const cleanMessage = sanitizeString(req.body.message, 2000);
    if (!cleanMessage) {
      return res.status(400).json({ success: false, error: 'Please enter a message.' });
    }

    const { error: insertError } = await supabase
      .from('contact_submissions')
      .insert({ email: cleanEmail, message: cleanMessage, ip_address: ip });

    if (insertError) {
      console.error('Error saving contact submission:', insertError);
      return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
    }

    // Respond only after both real outcomes (DB write, at least confirming
    // there's something to notify about) are known -- unlike
    // resend-dashboard-link, there's no enumeration timing concern here to
    // avoid, so awaiting before responding is fine and lets a genuine
    // send failure actually surface in the response instead of being
    // silently swallowed.
    const submittedAt = new Date();
    const [notifyResult, confirmResult] = await Promise.all([
      sendContactNotificationEmail(cleanEmail, cleanMessage, submittedAt),
      sendContactConfirmationEmail(cleanEmail, cleanMessage)
    ]);

    if (!notifyResult.success) {
      console.error('⚠️ Contact form saved but internal notification email failed:', notifyResult.error);
    }
    if (!confirmResult.success) {
      console.error('⚠️ Contact form saved but confirmation email to submitter failed:', confirmResult.error);
    }

    return res.json(GENERIC_CONTACT_RESPONSE);
  } catch (error) {
    console.error('Error in /api/contact:', error);
    return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ============================================
// UPLOAD DOG PHOTO (STEP 23 - Photo Upload)
// POST /api/upload-dog-photo
// ============================================

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory before uploading to Supabase
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB max
  },
  fileFilter: (req, file, cb) => {
    // Only allow image MIME types
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed. Only JPEG, PNG, and WebP images are supported.`));
    }
  }
});

app.post('/api/upload-dog-photo', upload.single('photo'), async (req, res) => {
  try {
    // Validate file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    // Extract dog_id from request
    const { dog_id } = req.body;
    if (!dog_id) {
      return res.status(400).json({
        success: false,
        error: 'Dog ID is required'
      });
    }

    console.log(`📸 Uploading photo for dog: ${dog_id}`);
    console.log(`📦 File: ${req.file.originalname} (${req.file.size} bytes)`);

    // Verify dog exists
    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('id')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      return res.status(404).json({
        success: false,
        error: 'Dog not found'
      });
    }

    // Generate unique filename: dog_id + timestamp + random + original extension
    const ext = path.extname(req.file.originalname);
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    const filename = `${dog_id}/${timestamp}-${randomStr}${ext}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('Dog_Photos')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase Storage upload error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload photo to storage'
      });
    }

    // Get public URL for the uploaded file
    const { data: { publicUrl } } = supabase
      .storage
      .from('Dog_Photos')
      .getPublicUrl(filename);

    console.log(`✅ Photo uploaded: ${publicUrl}`);

    // Update senior_dogs table with photo URL
    const { error: updateError } = await supabase
      .from('senior_dogs')
      .update({ photo_url: publicUrl })
      .eq('id', dog_id);

    if (updateError) {
      console.error('Error updating dog photo URL:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Photo uploaded but failed to save URL'
      });
    }

    // Success response
    res.json({
      success: true,
      message: `Photo uploaded successfully for ${dog_id}`,
      photo_url: publicUrl,
      filename: filename
    });

  } catch (error) {
    console.error('Error in upload-dog-photo endpoint:', error);

    // Handle multer file size errors
    if (error.message.includes('File too large')) {
      return res.status(400).json({
        success: false,
        error: 'File is too large. Maximum size is 5 MB.'
      });
    }

    // Handle multer file type errors
    if (error.message.includes('File type not allowed')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Server error uploading photo'
    });
  }
});

// ============================================
// STATIC PAGES (UNCHANGED)
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.get('/about.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'about.html'));
});

app.get('/independent.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'independent.html'));
});

app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'privacy.html'));
});

app.get('/governance.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'governance.html'));
});

app.get('/faq.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'faq.html'));
});

app.get('/founding.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'founding.html'));
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Send churn alert email (dog hasn't checked in)
// Shared unsubscribe footer for both churn email templates -- one
// implementation so the two templates can't drift the way headers/writes
// have drifted apart before in this project. Returns '' when ownerId is
// unavailable (e.g. the /api/test-email template-preview endpoint, which
// has no real owner to link to) rather than rendering a broken link.
function buildEmailUnsubscribeFooter(ownerId) {
  if (!ownerId) return '';
  return `
            <p style="color: #999; font-size: 11px; margin-top: 12px; text-align: center;">
              <a href="${BASE_URL}/unsubscribe/${ownerId}" style="color: #999;">Unsubscribe from these email reminders</a>
            </p>`;
}

async function sendChurnAlertEmail(ownerEmail, dogName, lastScore, lastCheckInDate, dogId, ownerId = null) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return;
  }

  try {
    // Escaped separately from the raw dogName used below in `subject` — a
    // plain-text email subject should never show literal HTML entities
    // (e.g. an apostrophe-containing name rendering as "O&#39;Brien"), but
    // the html body needs the escaped form.
    const dogNameSafe = escapeHtml(dogName);

    // lastCheckInDate is null when the dog has never had a real check-in —
    // in that case there's no real date to cite (the caller no longer
    // falls back to the signup date, which used to make this line stay
    // stuck on the same stale date forever). Only cite an actual date when
    // we have one.
    const sinceLine = lastCheckInDate
      ? `We noticed we haven't heard from you since <strong>${new Date(lastCheckInDate).toLocaleDateString()}</strong>. No pressure — we know life gets busy.`
      : `We noticed you haven't logged a check-in yet. No pressure — we know life gets busy.`;

    const msg = {
      to: ownerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: `How's ${dogName} this week? 👋`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Hey there! 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              ${sinceLine}
            </p>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              When you get a moment, we'd love to know how ${dogNameSafe}'s doing this week. One quick check-in takes 30 seconds and helps build a clear picture of ${dogNameSafe} and all the pet families participating.
            </p>
            <p style="color: #666; font-size: 14px; margin: 15px 0; line-height: 1.6;">
              <strong>Bonus:</strong> Every check-in helps us build a clearer picture of pet health for the whole community. 🐾
            </p>
            <div style="text-align: center; margin-top: 25px;">
              <a href="${BASE_URL}/dashboard/${dogId}" style="display: inline-block; background: #d96f56; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                View ${dogNameSafe}'s Progress and Update
              </a>
            </div>
            <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
              Companion Commons — Together we can change the future of pet health understanding
            </p>${buildEmailUnsubscribeFooter(ownerId)}
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Churn alert email sent to ${ownerEmail} for ${dogName}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending churn alert email for ${dogName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Join a list of dog names into readable prose: "Bailey", "Bailey and Max",
// or "Bailey, Max, and Rex". Used only by the combined churn email/SMS —
// the single-dog email path never calls this.
function joinDogNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// Send ONE combined churn alert email covering multiple dogs under the same
// owner (STAGE 4, multi-dog owner project). Same visual pattern as the
// single-dog sendChurnAlertEmail above — one "since we heard from you" line
// and one "View & Update" button per dog, all inside one email — rather
// than an owner with 2+ overdue dogs getting 2+ separate emails on the same
// day. See sendChurnAlertsForOwnerGroup, which decides when this vs. the
// single-dog template gets used.
async function sendCombinedChurnAlertEmail(ownerEmail, alerts) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return;
  }

  try {
    const names = alerts.map(a => a.dog.dog_name);
    const nameList = joinDogNames(names);
    // Escaped separately from the raw nameList used in `subject` below —
    // same reasoning as sendChurnAlertEmail's dogNameSafe.
    const nameListSafe = escapeHtml(nameList);

    const dogBlocks = alerts.map(({ dog, lastScore, lastCheckInDate }) => {
      const dogNameSafe = escapeHtml(dog.dog_name);
      const sinceLine = lastCheckInDate
        ? `We haven't heard from you about ${dogNameSafe} since <strong>${new Date(lastCheckInDate).toLocaleDateString()}</strong>.`
        : `You haven't logged a check-in for ${dogNameSafe} yet.`;
      return `
        <div style="border-top: 1px solid #eee; margin-top: 20px; padding-top: 20px;">
          <p style="color: #666; font-size: 15px; margin: 0 0 12px 0; line-height: 1.6;">${sinceLine}</p>
          <div style="text-align: center;">
            <a href="${BASE_URL}/dashboard/${dog.id}" style="display: inline-block; background: #d96f56; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
              View ${dogNameSafe}'s Progress and Update
            </a>
          </div>
        </div>
      `;
    }).join('');

    // Every alert in this group shares the same owner (see the grouping
    // in sendChurnAlertsForOwnerGroup's callers) -- derived here rather
    // than added as a new parameter, since alerts already carries it.
    const ownerId = alerts[0]?.dog?.owner_id || null;

    const msg = {
      to: ownerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: `How are ${nameList} doing this week? 👋`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Hey there! 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              No pressure — we know life gets busy. When you get a moment, we'd love a quick update on ${nameListSafe}. Each check-in takes 30 seconds and helps build a clear picture of your dogs and all the pet families participating.
            </p>
            ${dogBlocks}
            <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
              Companion Commons — Together we can change the future of pet health understanding
            </p>${buildEmailUnsubscribeFooter(ownerId)}
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Combined churn alert email sent to ${ownerEmail} for ${nameList}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending combined churn alert email for ${alerts.map(a => a.dog.dog_name).join(', ')}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// SHARED CHURN-EVALUATION LOGIC FOR ONE DOG
// Used by both the real hourly cron and the manual /api/test-churn-detection
// endpoint, so there's exactly one implementation to fix going forward —
// this is exactly why the baseline-period fix from earlier today lived in
// the cron but not the test endpoint until this refactor: two copies of the
// same logic had already started to drift.
//
// STAGE 4 (multi-dog owner project) change: this function used to send the
// churn re-engagement email itself. It no longer does — it only evaluates
// whether ONE dog needs an alert and returns that decision. The caller
// (the cron loop / test endpoint) now collects these per-dog decisions
// across a whole batch, groups them by owner_id, and sends ONE combined
// email per owner covering every dog that needs one — see
// sendChurnAlertsForOwnerGroup below. This is what actually fixes a
// two-dog owner getting two separate "haven't heard from you" emails on
// the same day. SMS reminder queueing stays per-dog here (unchanged) —
// combining those happens later, at actual send time, in the SMS-sending
// cron, since sibling dogs can be on different weeks/tiers.
//
// options:
//   sendSmsReminders (bool) — the real cron queues SMS check-in reminders;
//     the manual test endpoint never has, on purpose — a manual trigger
//     shouldn't have SMS side effects.
//
// Returns { skipped: true, reason, currentWeek? } or
//         { skipped: false, needsAlert: true, dog, lastScore, lastCheckInDate, currentWeek }
// so each caller can group/log/count in whatever style it already uses.
// ============================================
async function evaluateDogForChurn(dog, options = {}) {
  const { sendSmsReminders = false } = options;

  // Defensive floor: a created_at slightly in the future (timezone quirk,
  // clock skew) can make (now - created) negative, which would floor to
  // week 0 without this guard — this is what produced the real "Week #0"
  // text a user received. Same bug class as the streak week-0 issue from
  // the 27C session.
  const created = new Date(dog.created_at);
  const now = new Date();

  // Baseline-period gate — same pattern already used by the check-in
  // submission routes (daysSinceSignupForCheckin / daysSinceSignupForSave)
  // and the dashboard (isInBaselinePeriod): a dog's first check-in isn't
  // even available until 7 full days after signup, so they can't be
  // "missing" one before then. Skip entirely — no email, no SMS reminder
  // queue, no churn_flags record — there's nothing to flag yet.
  const daysSinceSignupForChurn = (now - created) / (24 * 60 * 60 * 1000);
  const isInBaselinePeriod = Math.floor(daysSinceSignupForChurn / 7) === 0;
  if (isInBaselinePeriod) {
    return { skipped: true, reason: 'baseline_period' };
  }

  const currentWeek = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

  // Check if dog has a check-in for this week
  const { data: thisWeekCheckin } = await supabase
    .from('mobility_checkins')
    .select('id')
    .eq('dog_id', dog.id)
    .eq('week_number', currentWeek)
    .limit(1);

  // If they DO have a check-in this week, skip them
  if (thisWeekCheckin && thisWeekCheckin.length > 0) {
    return { skipped: true, reason: 'has_checkin_this_week', currentWeek };
  }

  // Calculate reminder times based on CURRENT WEEK (not creation date).
  // Computed unconditionally (not just inside the sendSmsReminders block
  // below) because the churn-email gate further down also needs
  // reminderDay1, regardless of whether this call is queueing SMS.
  // Week 1 starts on creation date
  // Week 2 starts 7 days after creation
  // Week X starts on (creation + (7 * (X-1)) days)
  const weekStartDate = new Date(created);
  weekStartDate.setDate(weekStartDate.getDate() + (7 * (currentWeek - 1)));

  // Reminder #1: Start of week at 2pm
  const reminderDay1 = new Date(weekStartDate);
  reminderDay1.setHours(14, 0, 0, 0); // 2pm

  if (sendSmsReminders) {
    // ============================================
    // FLOW 2: AUTO SMS REMINDERS (Missing check-in notifications)
    // Sends SMS at 2pm (Day 7), 7pm (+4h), and 7:30am next day
    // ============================================

    // Reminder #2: Same day at 7pm (+4 hours)
    const reminderDay2At7pm = new Date(reminderDay1);
    reminderDay2At7pm.setHours(19, 0, 0, 0); // 7pm

    // Reminder #3: Next day at 7:30am (weekday) or 2pm (weekend)
    const reminderDay3 = new Date(reminderDay1);
    reminderDay3.setDate(reminderDay3.getDate() + 1);
    const day3OfWeek = reminderDay3.getDay();
    const day3Time = (day3OfWeek === 0 || day3OfWeek === 6) ? '14:00' : '07:30'; // 2pm weekend, 7:30am weekday
    const [day3Hours, day3Mins] = day3Time.split(':').map(Number);
    reminderDay3.setHours(day3Hours, day3Mins, 0, 0);

    // Check what SMS reminders have been queued/sent for this dog/week
    const { data: sentSms } = await supabase
      .from('sms_queue')
      .select('id, scheduled_for, status, message_type')
      .eq('pet_id', dog.id)
      .like('message_type', `week_${currentWeek}%`)
      .order('scheduled_for', { ascending: true });

    // Check if specific reminders have been sent
    const reminder1Sent = sentSms?.some(s => s.message_type.includes('reminder_1'));
    const reminder2Sent = sentSms?.some(s => s.message_type.includes('reminder_2'));
    const reminder3Sent = sentSms?.some(s => s.message_type.includes('reminder_3'));

    // Debug: Show reminder timing
    if (currentWeek >= 2) {
      console.log(`  ⏰ ${dog.dog_name}: Reminder #1 fires at ${reminderDay1.toLocaleString()}, Reminder #2 at ${reminderDay2At7pm.toLocaleString()}, Reminder #3 at ${reminderDay3.toLocaleString()}`);
    }

    const reminderCheckinLink = `${BASE_URL}/check-in/${dog.id}`;
    const canTextThisDog = !!(dog.phone && dog.sms_consent);

    if (!dog.phone) {
      console.warn(`⚠️ ${dog.dog_name} has no phone on file — skipping reminder queue (they signed up before phone numbers were saved to the profile)`);
    } else if (!dog.sms_consent) {
      console.log(`ℹ️ ${dog.dog_name}'s owner didn't opt in to SMS reminders — skipping`);
    }

    // REMINDER #1 (2pm): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay1 && !reminder1Sent && canTextThisDog) {
      const { error: queueError1 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          owner_id: dog.owner_id || null,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_1`,
          scheduled_for: reminderDay1.toISOString(),
          message_body: `${dog.dog_name}'s #${currentWeek} week check-in time! Click here to complete a 30-second update: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError1) {
        console.error(`❌ Error queueing reminder #1 for ${dog.dog_name}:`, queueError1.message);
      } else {
        console.log(`📱 Queued reminder #1 (2pm) for ${dog.dog_name}`);
      }
    }

    // REMINDER #2 (7pm): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay2At7pm && !reminder2Sent && canTextThisDog) {
      const { error: queueError2 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          owner_id: dog.owner_id || null,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_2`,
          scheduled_for: reminderDay2At7pm.toISOString(),
          message_body: `${dog.dog_name}'s week #${currentWeek} check-in - no rush, update when you can: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError2) {
        console.error(`❌ Error queueing reminder #2 for ${dog.dog_name}:`, queueError2.message);
      } else {
        console.log(`📱 Queued reminder #2 (7pm) for ${dog.dog_name}`);
      }
    }

    // REMINDER #3 (7:30am/2pm next day): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay3 && !reminder3Sent && canTextThisDog) {
      const { error: queueError3 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          owner_id: dog.owner_id || null,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_3`,
          scheduled_for: reminderDay3.toISOString(),
          message_body: `${dog.dog_name}'s week #${currentWeek} check-in - every update helps the community: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError3) {
        console.error(`❌ Error queueing reminder #3 for ${dog.dog_name}:`, queueError3.message);
      } else {
        console.log(`📱 Queued reminder #3 (${day3Time}) for ${dog.dog_name}`);
      }
    }
  }

  // Don't send the churn email before Reminder #1 would have gone out
  // (2pm on the first day of the missed week) — same time-check pattern
  // already used for the SMS reminders themselves, just above. Without
  // this, the email had no gate at all and could fire on the very first
  // cron tick after midnight, hours before any SMS reminder went out.
  if (now < reminderDay1) {
    return { skipped: true, reason: 'before_first_reminder_time', currentWeek };
  }

  // Dog is missing this week's check-in. Check if we've already alerted for
  // this dog+week at all — once per missed week, not a rolling 24h re-fire.
  // (Real bug, found via a full communications-cost trace: this used to
  // only skip if the last alert was <24h old, so an unresolved week could
  // re-send roughly daily with no cap — up to ~7 emails in a single missed
  // week. week_number already scopes this correctly per week; the fix is
  // just dropping the age check, not a schema change.)
  const { data: existingAlert } = await supabase
    .from('churn_flags')
    .select('id')
    .eq('dog_id', dog.id)
    .eq('week_number', currentWeek)
    .limit(1);

  if (existingAlert && existingAlert.length > 0) {
    console.log(`⏭️  ${dog.dog_name}: already emailed for week ${currentWeek}`);
    return { skipped: true, reason: 'already_alerted_this_week', currentWeek };
  }

  // Get last check-in to show context
  const { data: lastCheckin } = await supabase
    .from('mobility_checkins')
    .select('mobility_score, created_at')
    .eq('dog_id', dog.id)
    .order('created_at', { ascending: false })
    .limit(1);

  // ?? not || — see the identical fix in /api/checkin-senior (Stage 4a
  // review): 0 is a legitimate mobility_score on the new 0-10 scale, and
  // || would silently discard a real 0 in favor of the baseline instead.
  const lastScore = lastCheckin?.[0]?.mobility_score ?? dog.baseline_mobility_score;
  // null (not dog.created_at) when there's no real check-in yet — see
  // sendChurnAlertEmail, which branches on this instead of citing the
  // signup date as if it were a check-in date.
  const lastCheckInDate = lastCheckin?.[0]?.created_at || null;

  // This dog needs a churn alert. Don't send it here — the caller groups
  // this result with any of the same owner's other dogs that also need one
  // this pass, and sends a single combined email. See
  // sendChurnAlertsForOwnerGroup.
  return { skipped: false, needsAlert: true, dog, lastScore, lastCheckInDate, currentWeek };
}

// ============================================
// SEND CHURN ALERT(S) FOR ONE OWNER'S GROUP OF DOGS
// STAGE 4 (multi-dog owner project): takes every dog under one owner that
// evaluateDogForChurn just flagged as needing an alert this pass, and sends
// exactly ONE email — the existing single-dog copy/template when there's
// only one (unchanged, so the already-audited wording keeps working
// byte-for-byte), or a new combined template listing every dog when there's
// more than one. On success, writes a churn_flags row for EACH dog in the
// group, so the existing per-dog 24h dedup in evaluateDogForChurn keeps
// working exactly as before for every dog that was actually covered.
//
// alerts: array of { dog, lastScore, lastCheckInDate, currentWeek }, all
//   sharing the same owner (or all length-1 "solo" groups for dogs with no
//   owner_id — see the grouping in the cron/test-endpoint callers).
// options.emailOverride: same meaning as before — the manual test endpoint
//   always sends to SENDGRID_FROM_EMAIL instead of a real owner's address.
//
// Returns { sent: boolean, dogCount, reason? }
// ============================================
async function sendChurnAlertsForOwnerGroup(ownerEmail, alerts, options = {}) {
  const { emailOverride = null } = options;
  const toEmail = emailOverride || ownerEmail;

  if (!toEmail) {
    const names = alerts.map(a => a.dog.dog_name).join(', ');
    console.warn(`⚠️ No email on file for owner of ${names} — skipping churn alert email`);
    return { sent: false, dogCount: alerts.length, reason: 'no_email' };
  }

  // Real email opt-out check (added Sep 1 2026, closing the gap flagged in
  // faqs.html/privacy.html since Aug 31 -- see migration_add_email_opt_out.sql).
  // Scoped to the owner, since this email itself is owner-scoped (one
  // combined send per owner, not one per dog). Dogs with no owner_id
  // (legacy/ownerless, none currently live) have no owner row to check
  // against and behave exactly as before this change -- there's no real
  // unsubscribe target to scope an opt-out to for them.
  const ownerIdForOptOutCheck = alerts[0]?.dog?.owner_id || null;
  if (ownerIdForOptOutCheck) {
    const { data: ownerRow, error: ownerLookupError } = await supabase
      .from('owners')
      .select('email_opt_out')
      .eq('id', ownerIdForOptOutCheck)
      .single();
    if (ownerLookupError) {
      console.warn(`⚠️ Could not check email_opt_out for owner ${ownerIdForOptOutCheck}:`, ownerLookupError.message);
      // Fail open (send anyway) rather than silently and permanently
      // blocking a real owner's re-engagement email over a transient
      // lookup error -- same "don't let a glitch look like a deliberate
      // opt-out" reasoning as the emailResult failure branch below.
    } else if (ownerRow?.email_opt_out) {
      const names = alerts.map(a => a.dog.dog_name).join(', ');
      console.log(`⏭️  Owner of ${names} opted out of email reminders — skipping`);
      return { sent: false, dogCount: alerts.length, reason: 'email_opted_out' };
    }
  }

  const emailResult = alerts.length === 1
    ? await sendChurnAlertEmail(toEmail, alerts[0].dog.dog_name, alerts[0].lastScore, alerts[0].lastCheckInDate, alerts[0].dog.id, alerts[0].dog.owner_id)
    : await sendCombinedChurnAlertEmail(toEmail, alerts);

  // Either function returns undefined if SendGrid isn't configured at all,
  // or { success: false, error } if the send itself failed (e.g. the
  // SendGrid 403s seen during Aug 21 testing). Either way, this must not be
  // logged as a success and must NOT write any churn_flags rows — a failed
  // send isn't "already alerted," and writing the flags anyway would block
  // a legitimate retry on the next churn-detection pass, i.e. real owners
  // could silently never get re-engaged while the system insists it worked.
  if (!emailResult || !emailResult.success) {
    const reason = emailResult?.error || 'SendGrid not configured';
    const names = alerts.map(a => a.dog.dog_name).join(', ');
    console.error(`❌ Churn alert email FAILED for ${names}: ${reason}`);
    return { sent: false, dogCount: alerts.length, reason: 'email_failed' };
  }

  // Log the alert to churn_flags — one row per dog, so each dog's own
  // once-per-week dedup (checked in evaluateDogForChurn) is tracked
  // independently, exactly as it was before this dog's alerts started
  // being combined.
  for (const alert of alerts) {
    const { error: flagError } = await supabase
      .from('churn_flags')
      .insert({ dog_id: alert.dog.id, week_number: alert.currentWeek });
    if (flagError) {
      console.error(`Error logging churn flag for ${alert.dog.dog_name}:`, flagError);
    }
  }

  console.log(`✅ Churn alert email sent to ${toEmail} for ${alerts.map(a => a.dog.dog_name).join(', ')}`);
  return { sent: true, dogCount: alerts.length };
}

// Get next Tuesday at a specific time
function getNextTuesday() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilTuesday = (2 - dayOfWeek + 7) % 7 || 7;
    const nextTuesday = new Date(now);
    nextTuesday.setDate(nextTuesday.getDate() + daysUntilTuesday);
    nextTuesday.setHours(14, 0, 0, 0); // Default 2pm (afternoon)
    return nextTuesday;
}

// ============================================
// PERSONALIZED REMINDER SCHEDULING (STEP 26)
// Calculates next reminder based on user's submission day + personalized time
// Weekday (M-F): 7:30 AM | Weekend (Sat-Sun): 2:00 PM
// ============================================

// Get day name from day of week number
function getDayName(dayOfWeek) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayOfWeek];
}

// Calculate next reminder date (7 days from submission, same day, at personalized time)
function getNextReminderDate(submissionDayOfWeek, reminderTime) {
    // reminderTime format: "07:30" or "14:00"
    const [hours, minutes] = reminderTime.split(':').map(Number);

    // Start from 7 days from now
    const nextReminder = new Date();
    nextReminder.setDate(nextReminder.getDate() + 7);

    // Adjust to the same day of week as submission day
    const nextDayOfWeek = nextReminder.getDay();
    const daysToAdjust = (submissionDayOfWeek - nextDayOfWeek + 7) % 7;

    if (daysToAdjust !== 0) {
        nextReminder.setDate(nextReminder.getDate() + daysToAdjust);
    }

    // Set the time
    nextReminder.setHours(hours, minutes, 0, 0);

    return nextReminder;
}

// Get enrichment type for week
function getEnrichmentForWeek(week) {
    const enrichments = {
        1: 'enrichment_p3',  // Typical day
        2: 'enrichment_p5',  // Primary goal
        3: 'enrichment_p6',  // Peer comparison
        4: 'enrichment_p7'   // Network context
    };
    return enrichments[week] || null;
}

// Get enrichment SMS message
function getEnrichmentMessage(enrichmentType) {
    const messages = {
        'enrichment_p3': 'Bonus question: Describe a typical day for [PetName]. What activities happen morning, afternoon, evening?',
        'enrichment_p5': 'Bonus question: What\'s your main goal for [PetName]\'s health? (1) reduce pain, (2) increase activity, (3) monitor, (4) post-surgery, (5) weight mgmt',
        'enrichment_p6': 'Bonus question: Would you like to see how [PetName] compares to other [Breed], similar age? (Yes/No)',
        'enrichment_p7': 'Bonus question: Do you know other dogs with similar issues? (1) no others, (2) household, (3) friend group, (4) at vet'
    };
    return messages[enrichmentType] || '';
}

// ============================================
// CHURN DETECTION CRON JOB (Runs every 60 minutes)
// STEP 10 - Detects dogs missing check-ins and sends alerts
// ============================================
console.log('⏰ Churn detection interval scheduled (1 minute for testing)');
setInterval(async () => {
  try {
    console.log('🔍 Churn detection running...');

    // Get all senior dogs
    const { data: allDogs, error: dogsError } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, phone, email, sms_consent, owner_id, baseline_mobility_score, created_at');

    if (dogsError) {
      console.error('❌ Error fetching senior dogs:', dogsError.message);
      return;
    }

    if (!allDogs || allDogs.length === 0) {
      console.log('ℹ️ No dogs found for churn detection');
      return;
    }

    console.log(`📊 Checking ${allDogs.length} dogs for missing check-ins...`);

    // Pass 1: evaluate each dog independently (baseline-period fix,
    // this-week-checkin check, SMS reminder queueing, per-dog dedup) — see
    // evaluateDogForChurn above. Collect just the ones that need an alert.
    const needsAlert = [];
    for (const dog of allDogs) {
      try {
        const result = await evaluateDogForChurn(dog, { sendSmsReminders: true });
        if (!result.skipped && result.needsAlert) needsAlert.push(result);
      } catch (dogError) {
        console.error(`Error processing dog ${dog.id}:`, dogError.message);
      }
    }

    // Pass 2: group by owner_id (STAGE 4, multi-dog owner project) so an
    // owner with multiple overdue dogs gets ONE combined email instead of
    // one per dog. Dogs with no owner_id (legacy/ownerless) each form their
    // own solo group, matching today's exact per-dog behavior.
    const groups = new Map();
    for (const alert of needsAlert) {
      const key = alert.dog.owner_id || `solo:${alert.dog.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(alert);
    }

    for (const alerts of groups.values()) {
      await sendChurnAlertsForOwnerGroup(alerts[0].dog.email, alerts);
    }

    console.log('✅ Churn detection cycle complete');

  } catch (error) {
    console.error('❌ Error in churn detection cron:', error);
  }
}, 60 * 60 * 1000); // Run every 60 minutes (production)

// Build one combined SMS body for 2+ pending queue rows that share an
// owner and message kind (STAGE 4, multi-dog owner project). Deliberately
// omits the week number that the individual templates include — sibling
// dogs can legitimately be on different weeks, so no single number would be
// accurate for the whole group. Links to the new /checkins/:owner_id page
// instead of any one dog's own check-in link, since that page lists every
// dog for this owner with its own link — one short URL regardless of how
// many dogs are in the group, which is what keeps this inside the 160-char
// single-segment budget (see All_SMS_Communications.md).
async function buildCombinedSmsBody(group) {
    const petIds = group.map(m => m.pet_id);
    const { data: dogs } = await supabase
        .from('senior_dogs')
        .select('id, dog_name')
        .in('id', petIds);

    const names = petIds
        .map(id => dogs?.find(d => d.id === id)?.dog_name)
        .filter(Boolean);

    const link = `${BASE_URL}/checkins/${group[0].owner_id}`;
    const whoLine = names.length === 2
        ? `${names[0]} & ${names[1]}`
        : `${names.length || group.length} of your dogs`;

    return `${whoLine} have check-ins ready: ${link}`;
}

// ============================================
// SMS CRON JOB (Runs every 60 seconds)
// Automatically sends pending SMS messages
// ============================================
setInterval(async () => {
    try {
        const { data: pending } = await supabase
            .from('sms_queue')
            .select(`id, pet_id, owner_id, phone, message_body, message_type`)
            .eq('status', 'pending')
            .lte('scheduled_for', new Date().toISOString())
            .limit(10);

        if (!pending || pending.length === 0) return;

        // Group rows that can be safely combined into one outgoing text:
        // same owner (non-null — legacy/ownerless dogs never combine), same
        // message "kind" ignoring the week number (week_3_reminder_1 and
        // week_2_reminder_1 both normalize to reminder_1 — sibling dogs can
        // be on different weeks and still be due for the same reminder
        // tier at the same time). Rows without an owner_id each get their
        // own solo group, so they always send individually exactly as
        // before this change. See migration_add_sms_queue_owner_id.sql.
        const groups = new Map();
        for (const msg of pending) {
            const kind = (msg.message_type || '').replace(/^week_\d+_/, '');
            const key = msg.owner_id ? `${msg.owner_id}:${kind}` : `solo:${msg.id}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(msg);
        }

        for (const group of groups.values()) {
            if (!group[0].phone) {
                for (const msg of group) {
                    console.warn(`⚠️ No phone on queued message ${msg.id} (pet_id: ${msg.pet_id}), skipping SMS`);
                    await supabase
                        .from('sms_queue')
                        .update({ status: 'failed', error_message: 'No phone number' })
                        .eq('id', msg.id);
                }
                continue;
            }

            const body = group.length > 1
                ? await buildCombinedSmsBody(group)
                : group[0].message_body;

            try {
                const sent = await twilioClient.messages.create({
                    body,
                    from: TWILIO_PHONE_NUMBER,
                    to: group[0].phone
                });

                for (const msg of group) {
                    await supabase
                        .from('sms_queue')
                        .update({
                            status: 'sent',
                            twilio_sid: sent.sid,
                            sent_at: new Date().toISOString()
                        })
                        .eq('id', msg.id);
                }

                console.log(`✅ SMS sent to ${group[0].phone}${group.length > 1 ? ` (combined for ${group.length} dogs)` : ''}`);
            } catch (error) {
                console.error(`❌ Error sending SMS for group (phone ${group[0].phone}):`, error.message);
                for (const msg of group) {
                    await supabase
                        .from('sms_queue')
                        .update({
                            status: 'failed',
                            error_message: error.message
                        })
                        .eq('id', msg.id);
                }
            }
        }
    } catch (error) {
        console.error('Error in SMS cron:', error);
    }
}, 60000); // Run every 60 seconds

// ============================================
// GET ALL DOGS (for testing/debugging)
// ============================================
app.get('/api/get-all-dogs', async (req, res) => {
  try {
    const { data: dogs, error } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, breed, age, gender, baseline_mobility_score, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      total: dogs.length,
      dogs: dogs
    });
  } catch (error) {
    console.error('Error fetching dogs:', error);
    res.status(500).json({ error: 'Failed to fetch dogs' });
  }
});

// ============================================
// 404 HANDLER (must be last)
// ============================================
app.use((req, res) => {
    res.status(404).json({ error: 'Page not found' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`\n✅ CompanionCommons Server Running`);
    console.log(`📍 Web:   ${BASE_URL}`);
    console.log(`🎯 Admin: ${BASE_URL}/admin`);
    console.log(`📊 API:   ${BASE_URL}/api/signups`);
    console.log(`\n🗄️  Survey data now saves to Supabase (not signups.json)`);
    console.log(`💬 SMS cron running (sends pending SMS every 60 seconds)\n`);
});