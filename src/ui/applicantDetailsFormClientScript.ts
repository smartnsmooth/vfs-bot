/**
 * Inline page script for the applicant setup form. Kept in its own module so regex and
 * string escapes are not broken by nesting inside buildPageHtml's template literal.
 */
export function buildApplicantFormPageScript(collectLoginJs: string, isMultiInstanceJs: string, defaultNumInstancesJs: string): string {
  return `<script>
(function () {
  const collectLogin = ${collectLoginJs};
  let isMultiInstance = ${isMultiInstanceJs};

  function getNumInstances() {
    const el = document.getElementById("numInstances");
    if (!el) return ${defaultNumInstancesJs};
    // Prefer live value; fall back to HTML value attribute (some browsers briefly expose
    // empty .value before restore) then server default.
    const fromInput = (el instanceof HTMLInputElement && typeof el.valueAsNumber === "number" && Number.isFinite(el.valueAsNumber) && el.valueAsNumber >= 1)
      ? Math.floor(el.valueAsNumber)
      : NaN;
    if (Number.isFinite(fromInput)) return Math.min(50, fromInput);
    const parsed = parseInt(String(el.value).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(50, parsed);
    const fromAttr = parseInt(String(el.getAttribute("value") || "").trim(), 10);
    if (Number.isFinite(fromAttr) && fromAttr >= 1) return Math.min(50, fromAttr);
    const fallback = parseInt(String(${defaultNumInstancesJs}), 10);
    return Number.isFinite(fallback) && fallback >= 1 ? Math.min(50, fallback) : 1;
  }

  function updateInstanceSelector() {
    const numInstances = getNumInstances();
    isMultiInstance = numInstances > 1;

    const wrapper = document.getElementById("instanceSelectWrapper");
    // Always show the selector (even when numInstances=1)
    if (wrapper) wrapper.style.display = "block";

    const select = document.getElementById("instanceId");
    if (select) {
      const currentVal = parseInt(select.value, 10) || 1;
      select.innerHTML = "";
      for (let i = 1; i <= numInstances; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = "Instance " + i;
        if (i === Math.min(currentVal, numInstances)) opt.selected = true;
        select.appendChild(opt);
      }
    }

    const btn = document.getElementById("submitBtn");
    if (btn) btn.textContent = isMultiInstance ? "Submit & Run All Instances" : "Submit & Run Bot";
  }

  let autoSaveTimeout = null;
  let scheduleDatesUserEdited = false;

  function getScheduleAllowedDatesTextarea() {
    return document.getElementById("scheduleAllowedDatesHidden");
  }

  function parseScheduleAllowedDatesHidden(raw) {
    const s = String(raw || "").trim();
    if (!s) return [];
    const isoRe = /^\\d{4}-\\d{2}-\\d{2}$/;
    const tokens = s.split(/[|\\s,;]+/).map(function (t) {
      return t.trim();
    }).filter(Boolean);
    return Array.from(new Set(tokens.filter(function (x) {
      return isoRe.test(x);
    }))).sort();
  }

  function renderScheduleAllowedDateChips() {
    const hidden = getScheduleAllowedDatesTextarea();
    const box = document.getElementById("scheduleAllowedDatesChips");
    if (!hidden || !box) return;
    const dates = parseScheduleAllowedDatesHidden(hidden.value);
    box.innerHTML = "";
    for (let i = 0; i < dates.length; i++) {
      const iso = dates[i];
      const chip = document.createElement("span");
      chip.className = "date-chip";
      const lab = document.createElement("span");
      lab.textContent = iso;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "date-chip-remove";
      rm.setAttribute("aria-label", "Remove " + iso);
      rm.textContent = "×";
      rm.addEventListener("click", function () {
        scheduleDatesUserEdited = true;
        const next = parseScheduleAllowedDatesHidden(hidden.value).filter(function (d) {
          return d !== iso;
        });
        hidden.value = next.join("|");
        renderScheduleAllowedDateChips();
        if (isMultiInstance) scheduleAutoSave();
      });
      chip.appendChild(lab);
      chip.appendChild(rm);
      box.appendChild(chip);
    }
  }

  function addPickedScheduleDate() {
    const pick = document.getElementById("scheduleDatePicker");
    const hidden = getScheduleAllowedDatesTextarea();
    if (!hidden) return;
    const iso = pick && pick.value ? pick.value.trim() : "";
    if (!iso) return;
    scheduleDatesUserEdited = true;
    const merged = new Set(parseScheduleAllowedDatesHidden(hidden.value));
    merged.add(iso);
    hidden.value = Array.from(merged).sort().join("|");
    renderScheduleAllowedDateChips();
    if (isMultiInstance) scheduleAutoSave();
  }

  function queueAddPickedScheduleDateFromPicker() {
    const pick = document.getElementById("scheduleDatePicker");
    if (!pick) return;
    window.setTimeout(function () {
      addPickedScheduleDate();
    }, 0);
  }

  function clearAllScheduleAllowedDates() {
    scheduleDatesUserEdited = true;
    const hidden = getScheduleAllowedDatesTextarea();
    if (hidden) hidden.value = "";
    renderScheduleAllowedDateChips();
    if (isMultiInstance) scheduleAutoSave();
  }

  async function loadDefaults() {
    const r = await fetch("/api/defaults");
    const d = await r.json();
    if (!d.ok) return;
    const a = d.defaults || {};
    const skipDefaultIds = { numInstances: true, instanceId: true };
    for (const k of Object.keys(a)) {
      if (skipDefaultIds[k]) continue;
      if (k === "scheduleAllowedDates" && scheduleDatesUserEdited) continue;
      const el =
        k === "scheduleAllowedDates"
          ? getScheduleAllowedDatesTextarea()
          : document.getElementById(k);
      if (el) el.value = a[k] == null ? "" : String(a[k]);
    }
    if (collectLogin && d.loginDefaults && d.loginDefaults.vfsUsername) {
      const u = document.getElementById("vfsUsername");
      if (u) u.value = String(d.loginDefaults.vfsUsername);
    }
    if (collectLogin && d.loginDefaults && d.loginDefaults.vfsPassword != null) {
      const p = document.getElementById("vfsPassword");
      if (p) p.value = String(d.loginDefaults.vfsPassword);
    }
    if (collectLogin && d.loginDefaults && d.loginDefaults.vfsUsername2 != null) {
      const u2 = document.getElementById("vfsUsername2");
      if (u2) u2.value = String(d.loginDefaults.vfsUsername2 ?? "");
    }
    if (collectLogin && d.loginDefaults && d.loginDefaults.vfsPassword2 != null) {
      const p2 = document.getElementById("vfsPassword2");
      if (p2) p2.value = String(d.loginDefaults.vfsPassword2 ?? "");
    }
    renderScheduleAllowedDateChips();
  }

  async function loadInstanceData(showAlert) {
    if (!isMultiInstance) return;
    const instanceId = parseInt(document.getElementById("instanceId").value, 10);
    const r = await fetch("/api/instances");
    const data = await r.json();
    if (!data.ok) return;

    const inst = data.instances[String(instanceId)];
    if (!inst || (!inst.credentials && !inst.details)) {
      if (showAlert) {
        alert("No saved data for Instance " + instanceId);
      }
      if (collectLogin) {
        const uEl = document.getElementById("vfsUsername");
        const pEl = document.getElementById("vfsPassword");
        const u2El = document.getElementById("vfsUsername2");
        const p2El = document.getElementById("vfsPassword2");
        if (uEl) uEl.value = "";
        if (pEl) pEl.value = "";
        if (u2El) u2El.value = "";
        if (p2El) p2El.value = "";
      }
      const fieldsToClear = [
        "firstName",
        "lastName",
        "emailId",
        "dialCode",
        "contactNumber",
        "dateOfBirth",
        "passportNumber",
        "passportExpirtyDate",
        "vacCode",
        "selectedSubvisaCategory",
        "vacCode2",
        "selectedSubvisaCategory2",
      ];
      for (let fi = 0; fi < fieldsToClear.length; fi++) {
        const el = document.getElementById(fieldsToClear[fi]);
        if (el) el.value = "";
      }
      const genderEl = document.getElementById("gender");
      if (genderEl) genderEl.value = "1";
      const g0empty = data.instances["0"] && data.instances["0"].details ? data.instances["0"].details : {};
      const ta0 = getScheduleAllowedDatesTextarea();
      if (ta0 && !scheduleDatesUserEdited) {
        ta0.value =
          g0empty.scheduleAllowedDates != null ? String(g0empty.scheduleAllowedDates) : "";
      }
      renderScheduleAllowedDateChips();
      return;
    }

    if (collectLogin) {
      const uEl = document.getElementById("vfsUsername");
      const pEl = document.getElementById("vfsPassword");
      const u2El = document.getElementById("vfsUsername2");
      const p2El = document.getElementById("vfsPassword2");
      if (uEl) uEl.value = "";
      if (pEl) pEl.value = "";
      if (u2El) u2El.value = "";
      if (p2El) p2El.value = "";
    }
    const allFields = [
      "firstName",
      "lastName",
      "emailId",
      "dialCode",
      "contactNumber",
      "dateOfBirth",
      "passportNumber",
      "passportExpirtyDate",
      "vacCode",
      "selectedSubvisaCategory",
      "vacCode2",
      "selectedSubvisaCategory2",
    ];
    for (let ai = 0; ai < allFields.length; ai++) {
      const el = document.getElementById(allFields[ai]);
      if (el) el.value = "";
    }
    const genderEl2 = document.getElementById("gender");
    if (genderEl2) genderEl2.value = "1";

    if (inst.credentials && collectLogin) {
      const uEl = document.getElementById("vfsUsername");
      const pEl = document.getElementById("vfsPassword");
      const u2El = document.getElementById("vfsUsername2");
      const p2El = document.getElementById("vfsPassword2");
      if (uEl) uEl.value = inst.credentials.username || "";
      if (pEl) pEl.value = inst.credentials.password || "";
      if (u2El) u2El.value = inst.credentials.username2 != null ? String(inst.credentials.username2) : "";
      if (p2El) p2El.value = inst.credentials.password2 != null ? String(inst.credentials.password2) : "";
    }

    if (inst.details) {
      const skipDetailIds = { numInstances: true, instanceId: true, vfsUsername2: true, vfsPassword2: true };
      const keys = Object.keys(inst.details);
      for (let ki = 0; ki < keys.length; ki++) {
        const k = keys[ki];
        if (skipDetailIds[k]) continue;
        if (k === "scheduleAllowedDates") continue;
        const el = document.getElementById(k);
        if (el) el.value = inst.details[k] == null ? "" : String(inst.details[k]);
      }
    }
    const g0 = data.instances["0"] && data.instances["0"].details ? data.instances["0"].details : {};
    const ta = getScheduleAllowedDatesTextarea();
    if (ta && !scheduleDatesUserEdited) {
      ta.value = g0.scheduleAllowedDates != null ? String(g0.scheduleAllowedDates) : "";
    }
    renderScheduleAllowedDateChips();

    if (showAlert) {
      alert("Loaded saved data for Instance " + instanceId);
    }
  }

  async function saveFormData(showFeedback) {
    const form = document.getElementById("f");
    const fd = new FormData(form);
    const body = {
      firstName: String(fd.get("firstName") || "").toUpperCase(),
      lastName: String(fd.get("lastName") || "").toUpperCase(),
      emailId: String(fd.get("emailId") || "").toUpperCase(),
      dialCode: fd.get("dialCode"),
      contactNumber: fd.get("contactNumber"),
      dateOfBirth: fd.get("dateOfBirth"),
      passportNumber: String(fd.get("passportNumber") || "").toUpperCase(),
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: "IND",
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: fd.get("vacCode2") || undefined,
      selectedSubvisaCategory2: fd.get("selectedSubvisaCategory2") || undefined,
      scheduleAllowedDates: String(fd.get("scheduleAllowedDates") ?? ""),
      numInstances: getNumInstances(),
    };
    if (isMultiInstance) {
      body.instanceId = parseInt(String(fd.get("instanceId") || "1"), 10);
    }
    if (collectLogin) {
      body.vfsUsername = fd.get("vfsUsername");
      body.vfsPassword = fd.get("vfsPassword");
      body.vfsUsername2 = fd.get("vfsUsername2");
      body.vfsPassword2 = fd.get("vfsPassword2");
    }

    if (showFeedback) {
      const msg = document.getElementById("msg");
      msg.className = "";
      msg.textContent = "Saving...";
    }

    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (showFeedback) {
        const msg = document.getElementById("msg");
        if (j.ok) {
          msg.className = "ok";
          msg.textContent = isMultiInstance
            ? "✓ Saved for Instance " + body.instanceId
            : "✓ Saved";
        } else {
          msg.className = "err";
          msg.textContent = j.error || "Save failed";
        }
      }
    } catch (err) {
      if (showFeedback) {
        const msg = document.getElementById("msg");
        msg.className = "err";
        msg.textContent = String(err);
      }
    }
  }

  function scheduleAutoSave() {
    if (!isMultiInstance) return;
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
    }
    autoSaveTimeout = setTimeout(function () {
      saveFormData(false);
    }, 1000);
  }

  function wireScheduleAllowedDatesUi() {
    const scheduleAddBtn = document.getElementById("scheduleDateAddBtn");
    const schedulePicker = document.getElementById("scheduleDatePicker");
    const scheduleClearBtn = document.getElementById("scheduleDatesClearBtn");
    if (scheduleAddBtn) {
      scheduleAddBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        addPickedScheduleDate();
      });
    }
    if (schedulePicker) {
      schedulePicker.addEventListener("change", queueAddPickedScheduleDateFromPicker);
      schedulePicker.addEventListener("input", queueAddPickedScheduleDateFromPicker);
    }
    if (scheduleClearBtn) scheduleClearBtn.addEventListener("click", clearAllScheduleAllowedDates);
  }

  async function initApplicantForm() {
    try {
      // Wire the numInstances input to update the instance selector in real-time.
      const numInstancesInput = document.getElementById("numInstances");
      if (numInstancesInput) {
        numInstancesInput.addEventListener("input", function () {
          updateInstanceSelector();
          if (isMultiInstance) scheduleAutoSave();
        });
        numInstancesInput.addEventListener("change", function () {
          updateInstanceSelector();
          // After rebuilding the selector, load data for the now-selected instance.
          if (isMultiInstance) {
            scheduleDatesUserEdited = false;
            loadInstanceData(false);
          } else {
            loadDefaults();
          }
        });
      }

      // Sync select option count with #numInstances before any async load (avoids empty
      // .value being read as 1 and wiping server-rendered options).
      updateInstanceSelector();

      // Always wire the instanceId change listener — the element is always in the DOM.
      // loadInstanceData() and scheduleAutoSave() both guard themselves with isMultiInstance.
      const instanceIdSelect = document.getElementById("instanceId");
      if (instanceIdSelect) {
        instanceIdSelect.addEventListener("change", function () {
          scheduleDatesUserEdited = false;
          loadInstanceData(false);
        });
      }

      // Always wire auto-save so it kicks in as soon as the user switches to multi-instance.
      const form = document.getElementById("f");
      form.querySelectorAll("input, select, textarea").forEach(function (input) {
        input.addEventListener("input", scheduleAutoSave);
        input.addEventListener("change", scheduleAutoSave);
      });

      if (isMultiInstance) {
        await loadInstanceData(false);
      } else {
        await loadDefaults();
      }

      // After defaults / instance payload, keep the instance dropdown aligned with #numInstances.
      updateInstanceSelector();
    } catch (err) {
      console.error("initApplicantForm failed", err);
    }
  }

  wireScheduleAllowedDatesUi();
  void initApplicantForm();

  const capitalizeFields = ["firstName", "lastName", "emailId", "passportNumber"];
  for (let ci = 0; ci < capitalizeFields.length; ci++) {
    const fieldId = capitalizeFields[ci];
    const el = document.getElementById(fieldId);
    if (el) {
      el.addEventListener("input", function (e) {
        const start = e.target.selectionStart;
        const end = e.target.selectionEnd;
        e.target.value = e.target.value.toUpperCase();
        e.target.setSelectionRange(start, end);
      });
    }
  }

  document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    const msg = document.getElementById("msg");
    msg.textContent = "";
    const fd = new FormData(e.target);
    const body = {
      firstName: String(fd.get("firstName") || "").toUpperCase(),
      lastName: String(fd.get("lastName") || "").toUpperCase(),
      emailId: String(fd.get("emailId") || "").toUpperCase(),
      dialCode: fd.get("dialCode"),
      contactNumber: fd.get("contactNumber"),
      dateOfBirth: fd.get("dateOfBirth"),
      passportNumber: String(fd.get("passportNumber") || "").toUpperCase(),
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: "IND",
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: fd.get("vacCode2") || undefined,
      selectedSubvisaCategory2: fd.get("selectedSubvisaCategory2") || undefined,
      scheduleAllowedDates: String(fd.get("scheduleAllowedDates") ?? ""),
      numInstances: getNumInstances(),
    };
    if (isMultiInstance) {
      body.instanceId = parseInt(String(fd.get("instanceId") || "1"), 10);
    }
    if (collectLogin) {
      body.vfsUsername = fd.get("vfsUsername");
      body.vfsPassword = fd.get("vfsPassword");
      body.vfsUsername2 = fd.get("vfsUsername2");
      body.vfsPassword2 = fd.get("vfsPassword2");
    }
    try {
      const r = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        msg.className = "ok";
        if (isMultiInstance) {
          msg.textContent =
            "✓ Started " + (j.queued || "all") + " bot instance(s). Check terminal for progress.";
        } else {
          msg.textContent = j.firstSubmit
            ? "Saved — bot run started in the background. Submit again for another run or to refresh data."
            : "Saved — another bot run was queued. Check the terminal for progress.";
        }
      } else {
        msg.className = "err";
        msg.textContent = j.error || "Submit failed";
      }
    } catch (err) {
      msg.className = "err";
      msg.textContent = String(err);
    }
  });
})();
</script>`;
}
