/**
 * Inline page script for the applicant setup form. Kept in its own module so regex and
 * string escapes are not broken by nesting inside buildPageHtml's template literal.
 */
export function buildApplicantFormPageScript(collectLoginJs: string): string {
  return `<script>
(function () {
  const collectLogin = ${collectLoginJs};

  function getNumInstances() {
    const el = document.getElementById("numInstances");
    if (!el) return 1;
    const fromInput = (el instanceof HTMLInputElement && typeof el.valueAsNumber === "number" && Number.isFinite(el.valueAsNumber) && el.valueAsNumber >= 1)
      ? Math.floor(el.valueAsNumber)
      : NaN;
    if (Number.isFinite(fromInput)) return Math.min(50, fromInput);
    const parsed = parseInt(String(el.value).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(50, parsed);
    const fromAttr = parseInt(String(el.getAttribute("value") || "").trim(), 10);
    if (Number.isFinite(fromAttr) && fromAttr >= 1) return Math.min(50, fromAttr);
    return 1;
  }

  function updateInstanceSelector() {
    const numInstances = getNumInstances();

    const wrapper = document.getElementById("instanceSelectWrapper");
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
  }

  const countryMissionMap = {
    ind: [{label: "Bulgaria", value: "bgr"}],
    egy: [{label: "Portugal", value: "prt"}],
    sau: [{label: "Portugal", value: "prt"}],
  };

  const centerCategoryMap = {
    "ind-bgr": [
      { value: "JAI", label: "Bulgaria Visa Application Centre-Jaipur", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "HYD", label: "Bulgaria Visa Application Centre-Hyderabad", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "JLD", label: "Bulgaria Visa Application Centre-Jalandhar", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "BLR", label: "Bulgaria Visa Application Center ,Bangalore", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "IXC", label: "Bulgaria Visa Application Centre-Chandigarh", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "PNQ", label: "Bulgaria Visa Application Centre-Pune", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "COK", label: "Bulgaria Visa Application Centre-Cochin", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "GOI", label: "Bulgaria Visa Application Centre-Goa", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "AMD", label: "Bulgaria Visa Application Centre-Ahmedabad", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "PUD", label: "Bulgaria Visa Application Centre-Puducherry", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "GUR", label: "Bulgaria Visa Application Center ,Gurugram", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "NDEL", label: "Bulgaria Visa Application Center ,New Delhi", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "BKC", label: "Bulgaria Visa Application Center, Mumbai", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "MAA", label: "Bulgaria Visa Application Centre-Chennai", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
      { value: "CCU", label: "Bulgarian visa application center-Kolkata-VAC", categories: [
        { value: "LONGSTAY", label: "Long Stay D visa" },
        { value: "SAW", label: "Seasonal worker" },
        { value: "Busi", label: "Business Visa" },
      ]},
    ],
    "egy-prt": [
      { value: "POAL", label: "Portugal Visa Application Center-Alexandria", categories: [
        { value: "JB", label: "Job seeker" },
        { value: "LT", label: "Long Term Visa - National" },
        { value: "SWC", label: "Subordinated Work" },
        { value: "Apel", label: "Appeal against the decision" },
      ]},
      { value: "POCA", label: "Portugal Visa Application Center-Cairo", categories: [
        { value: "JB", label: "Job seeker" },
        { value: "LT", label: "Long Term Visa - National" },
        { value: "DV", label: "Long term Visa- E visa" },
        { value: "SWC", label: "Subordinated Work" },
        { value: "Apel", label: "Appeal against the decision" },
      ]},
    ],
  };

  var manualApplicantRoutes = { "egy-prt": true };
  var manualApplicantFieldIds = ["firstName", "lastName", "dateOfBirth", "passportNumber", "dialCode", "contactNumber"];

  function getRouteKey() {
    var cc = (document.getElementById("countryCode") || {}).value || "";
    var mc = (document.getElementById("missionCode") || {}).value || "";
    return cc + "-" + mc;
  }

  function isManualApplicantRoute() {
    return !!manualApplicantRoutes[getRouteKey()];
  }

  function updateManualApplicantFields() {
    var el = document.getElementById("manualApplicantFields");
    if (el) el.style.display = isManualApplicantRoute() ? "" : "none";
  }

  function updateMissionOptions() {
    const countryEl = document.getElementById("countryCode");
    const missionEl = document.getElementById("missionCode");
    if (!countryEl || !missionEl) return;
    const country = countryEl.value;
    const prevMission = missionEl.value;
    const options = countryMissionMap[country] || [];
    missionEl.innerHTML = "";
    for (let i = 0; i < options.length; i++) {
      const opt = document.createElement("option");
      opt.value = options[i].value;
      opt.textContent = options[i].label;
      if (options[i].value === prevMission) opt.selected = true;
      missionEl.appendChild(opt);
    }
    updateCenterOptions();
    updateManualApplicantFields();
  }

  function populateCenterSelect(selectId, placeholderText, centers, prevValue) {
    const el = document.getElementById(selectId);
    if (!el) return;
    el.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = placeholderText;
    el.appendChild(ph);
    for (let i = 0; i < centers.length; i++) {
      const opt = document.createElement("option");
      opt.value = centers[i].value;
      opt.textContent = centers[i].label;
      if (centers[i].value === prevValue) opt.selected = true;
      el.appendChild(opt);
    }
  }

  function populateCategorySelect(selectId, categories, prevValue) {
    const el = document.getElementById(selectId);
    if (!el) return;
    el.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "-- Select Category --";
    el.appendChild(ph);
    for (let i = 0; i < categories.length; i++) {
      const opt = document.createElement("option");
      opt.value = categories[i].value;
      opt.textContent = categories[i].label;
      if (categories[i].value === prevValue) opt.selected = true;
      el.appendChild(opt);
    }
  }

  function updateCenterOptions() {
    var key = getRouteKey();
    var centers = centerCategoryMap[key] || [];
    var prevVac1 = (document.getElementById("vacCode") || {}).value || "";
    var prevVac2 = (document.getElementById("vacCode2") || {}).value || "";
    populateCenterSelect("vacCode", "-- Select Centre --", centers, prevVac1);
    populateCenterSelect("vacCode2", "-- No Second Centre --", centers, prevVac2);
    updateCategoryOptions("vacCode", "selectedSubvisaCategory");
    updateCategoryOptions("vacCode2", "selectedSubvisaCategory2");
  }

  function updateCategoryOptions(centerSelectId, categorySelectId) {
    var key = getRouteKey();
    var centers = centerCategoryMap[key] || [];
    var centerEl = document.getElementById(centerSelectId);
    var prevCat = (document.getElementById(categorySelectId) || {}).value || "";
    var categories = [];
    if (centerEl && centerEl.value) {
      for (var i = 0; i < centers.length; i++) {
        if (centers[i].value === centerEl.value) {
          categories = centers[i].categories;
          break;
        }
      }
    }
    populateCategorySelect(categorySelectId, categories, prevCat);
  }

  let autoSaveTimeout = null;
  let scheduleRangeUserEdited = false;

  function getScheduleRangeStartEl() {
    return document.getElementById("scheduleDateRangeStart");
  }

  function getScheduleRangeEndEl() {
    return document.getElementById("scheduleDateRangeEnd");
  }

  function applyInstanceScheduleRangeToForm(details) {
    if (scheduleRangeUserEdited) return;
    const sEl = getScheduleRangeStartEl();
    const eEl = getScheduleRangeEndEl();
    if (!sEl || !eEl) return;
    const d = details || {};
    sEl.value = d.scheduleDateRangeStart != null ? String(d.scheduleDateRangeStart).trim().slice(0, 10) : "";
    eEl.value = d.scheduleDateRangeEnd != null ? String(d.scheduleDateRangeEnd).trim().slice(0, 10) : "";
  }

  async function loadInstanceData(showAlert) {
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
      const ccEl = document.getElementById("countryCode");
      if (ccEl) ccEl.value = "ind";
      updateMissionOptions();
      const mcEl = document.getElementById("missionCode");
      if (mcEl) mcEl.value = "bgr";
      var fieldsToClear = [
        "passportExpirtyDate",
        "nationalityCode",
        "vacCode",
        "selectedSubvisaCategory",
        "vacCode2",
        "selectedSubvisaCategory2",
      ].concat(manualApplicantFieldIds);
      for (let fi = 0; fi < fieldsToClear.length; fi++) {
        const el = document.getElementById(fieldsToClear[fi]);
        if (el) el.value = "";
      }
      const genderEl = document.getElementById("gender");
      if (genderEl) genderEl.value = "1";
      applyInstanceScheduleRangeToForm({});
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
    var allFields = [
      "passportExpirtyDate",
      "nationalityCode",
      "vacCode",
      "selectedSubvisaCategory",
      "vacCode2",
      "selectedSubvisaCategory2",
    ].concat(manualApplicantFieldIds);
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
      const skipDetailIds = { numInstances: true, instanceId: true, vfsUsername2: true, vfsPassword2: true, countryCode: true, missionCode: true };
      const ccEl = document.getElementById("countryCode");
      if (ccEl && inst.details.countryCode) ccEl.value = String(inst.details.countryCode);
      updateMissionOptions();
      const mcEl = document.getElementById("missionCode");
      if (mcEl && inst.details.missionCode) { mcEl.value = String(inst.details.missionCode); updateCenterOptions(); }

      const skipCenterCatIds = { vacCode: true, selectedSubvisaCategory: true, vacCode2: true, selectedSubvisaCategory2: true };
      const keys = Object.keys(inst.details);
      for (let ki = 0; ki < keys.length; ki++) {
        const k = keys[ki];
        if (skipDetailIds[k] || skipCenterCatIds[k]) continue;
        if (k === "scheduleDateRangeStart" || k === "scheduleDateRangeEnd") continue;
        const el = document.getElementById(k);
        if (el) el.value = inst.details[k] == null ? "" : String(inst.details[k]);
      }
      var vc1El = document.getElementById("vacCode");
      if (vc1El && inst.details.vacCode) vc1El.value = String(inst.details.vacCode);
      updateCategoryOptions("vacCode", "selectedSubvisaCategory");
      var sc1El = document.getElementById("selectedSubvisaCategory");
      if (sc1El && inst.details.selectedSubvisaCategory) sc1El.value = String(inst.details.selectedSubvisaCategory);
      var vc2El = document.getElementById("vacCode2");
      if (vc2El && inst.details.vacCode2) vc2El.value = String(inst.details.vacCode2);
      updateCategoryOptions("vacCode2", "selectedSubvisaCategory2");
      var sc2El = document.getElementById("selectedSubvisaCategory2");
      if (sc2El && inst.details.selectedSubvisaCategory2) sc2El.value = String(inst.details.selectedSubvisaCategory2);
    }
    applyInstanceScheduleRangeToForm(inst.details || {});

    // postLoginPollDelay is global (instance 0); apply from whichever source has it.
    const globalInst = data.instances["0"];
    const plpdEl = document.getElementById("postLoginPollDelay");
    if (plpdEl) {
      const src = (globalInst && globalInst.details) || (inst && inst.details) || {};
      plpdEl.value = src.postLoginPollDelay != null ? String(src.postLoginPollDelay) : "30";
    }

    if (showAlert) {
      alert("Loaded saved data for Instance " + instanceId);
    }
  }

  async function saveFormData(showFeedback) {
    const form = document.getElementById("f");
    const fd = new FormData(form);
    const body = {
      countryCode: fd.get("countryCode") || "ind",
      missionCode: fd.get("missionCode") || "bgr",
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: String(fd.get("nationalityCode") || "").trim(),
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: fd.get("vacCode2") || undefined,
      selectedSubvisaCategory2: fd.get("selectedSubvisaCategory2") || undefined,
      firstName: String(fd.get("firstName") || "").trim() || undefined,
      lastName: String(fd.get("lastName") || "").trim() || undefined,
      dateOfBirth: String(fd.get("dateOfBirth") || "").trim() || undefined,
      passportNumber: String(fd.get("passportNumber") || "").trim() || undefined,
      dialCode: String(fd.get("dialCode") || "").trim() || undefined,
      contactNumber: String(fd.get("contactNumber") || "").trim() || undefined,
      scheduleDateRangeStart: String(fd.get("scheduleDateRangeStart") ?? "").trim(),
      scheduleDateRangeEnd: String(fd.get("scheduleDateRangeEnd") ?? "").trim(),
      numInstances: getNumInstances(),
      userPollInterval: parseInt(String(fd.get("userPollInterval") || "60"), 10) || 60,
      postLoginPollDelay: parseInt(String(fd.get("postLoginPollDelay") || "30"), 10),
      instanceId: parseInt(String(fd.get("instanceId") || "1"), 10),
    };
    if (!Number.isFinite(body.postLoginPollDelay) || body.postLoginPollDelay < 0) body.postLoginPollDelay = 30;
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
          msg.textContent = "\\u2713 Saved for Instance " + body.instanceId;
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
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
    }
    autoSaveTimeout = setTimeout(function () {
      saveFormData(false);
    }, 1000);
  }

  async function initApplicantForm() {
    try {
      const countryCodeSelect = document.getElementById("countryCode");
      if (countryCodeSelect) {
        countryCodeSelect.addEventListener("change", function () {
          updateMissionOptions();
          scheduleAutoSave();
        });
      }
      const missionCodeSelect = document.getElementById("missionCode");
      if (missionCodeSelect) {
        missionCodeSelect.addEventListener("change", function () {
          updateCenterOptions();
          scheduleAutoSave();
        });
      }
      const vacCodeSelect = document.getElementById("vacCode");
      if (vacCodeSelect) {
        vacCodeSelect.addEventListener("change", function () {
          updateCategoryOptions("vacCode", "selectedSubvisaCategory");
          scheduleAutoSave();
        });
      }
      const vacCode2Select = document.getElementById("vacCode2");
      if (vacCode2Select) {
        vacCode2Select.addEventListener("change", function () {
          updateCategoryOptions("vacCode2", "selectedSubvisaCategory2");
          scheduleAutoSave();
        });
      }
      updateMissionOptions();

      const numInstancesInput = document.getElementById("numInstances");
      if (numInstancesInput) {
        numInstancesInput.addEventListener("input", function () {
          updateInstanceSelector();
          scheduleAutoSave();
        });
        numInstancesInput.addEventListener("change", function () {
          updateInstanceSelector();
          scheduleRangeUserEdited = false;
          loadInstanceData(false);
        });
      }

      updateInstanceSelector();

      const instanceIdSelect = document.getElementById("instanceId");
      if (instanceIdSelect) {
        instanceIdSelect.addEventListener("change", function () {
          scheduleRangeUserEdited = false;
          loadInstanceData(false);
        });
      }

      const form = document.getElementById("f");
      form.querySelectorAll("input, select, textarea").forEach(function (input) {
        input.addEventListener("input", scheduleAutoSave);
        input.addEventListener("change", scheduleAutoSave);
      });

      await loadInstanceData(false);

      updateInstanceSelector();
    } catch (err) {
      console.error("initApplicantForm failed", err);
    }
  }

  (function wireScheduleRangeInputs() {
    const s = getScheduleRangeStartEl();
    const e = getScheduleRangeEndEl();
    function markEdited() {
      scheduleRangeUserEdited = true;
      scheduleAutoSave();
    }
    if (s) {
      s.addEventListener("change", markEdited);
      s.addEventListener("input", markEdited);
    }
    if (e) {
      e.addEventListener("change", markEdited);
      e.addEventListener("input", markEdited);
    }
  })();
  void initApplicantForm();

  document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    const msg = document.getElementById("msg");
    msg.textContent = "";
    const fd = new FormData(e.target);
    const body = {
      countryCode: fd.get("countryCode") || "ind",
      missionCode: fd.get("missionCode") || "bgr",
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: String(fd.get("nationalityCode") || "").trim(),
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: fd.get("vacCode2") || undefined,
      selectedSubvisaCategory2: fd.get("selectedSubvisaCategory2") || undefined,
      firstName: String(fd.get("firstName") || "").trim() || undefined,
      lastName: String(fd.get("lastName") || "").trim() || undefined,
      dateOfBirth: String(fd.get("dateOfBirth") || "").trim() || undefined,
      passportNumber: String(fd.get("passportNumber") || "").trim() || undefined,
      dialCode: String(fd.get("dialCode") || "").trim() || undefined,
      contactNumber: String(fd.get("contactNumber") || "").trim() || undefined,
      scheduleDateRangeStart: String(fd.get("scheduleDateRangeStart") ?? "").trim(),
      scheduleDateRangeEnd: String(fd.get("scheduleDateRangeEnd") ?? "").trim(),
      numInstances: getNumInstances(),
      userPollInterval: parseInt(String(fd.get("userPollInterval") || "60"), 10) || 60,
      postLoginPollDelay: parseInt(String(fd.get("postLoginPollDelay") || "30"), 10),
      instanceId: parseInt(String(fd.get("instanceId") || "1"), 10),
    };
    if (!Number.isFinite(body.postLoginPollDelay) || body.postLoginPollDelay < 0) body.postLoginPollDelay = 30;
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
        msg.textContent =
          "\\u2713 Started " + (j.queued || "all") + " bot instance(s). Check terminal for progress.";
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
