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
    if (Number.isFinite(fromInput)) return Math.min(100, fromInput);
    const parsed = parseInt(String(el.value).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(100, parsed);
    const fromAttr = parseInt(String(el.getAttribute("value") || "").trim(), 10);
    if (Number.isFinite(fromAttr) && fromAttr >= 1) return Math.min(100, fromAttr);
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
    ind: [
      { label: "Bulgaria", value: "bgr" },
      { label: "Latvia", value: "lva" },
      { label: "Germany", value: "deu" },
    ],
    egy: [{label: "Portugal", value: "prt"}],
    sau: [{label: "Portugal", value: "prt"}],
    uzb: [{ label: "Latvia", value: "lva" }],
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
    "ind-lva": [
      {
        value: "LVAIND",
        label: "Latvia Visa Application Centre – India",
        categories: [
          { value: "EmployL", label: "Employment" },
          { value: "BUS", label: "Business" },
        ],
      },
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
    "uzb-lva": [
      { value: "TAS", label: "VFS GLOBAL SERVICES UBKN", categories: [
        { value: "LNGWORKTJK", label: "Cargo drivers (Visa D) Tajik" },
        { value: "LNGWORK", label: "Cargo drivers (Visa D) Uzbek, Turkmen" },
        { value: "OCMA T", label: "OCMA decision Tajik" },
        { value: "LNGOTHR", label: "OCMA decision Uzbek, Turkmen" },
        { value: "Visa D SW", label: "Seasonal Works" },
        { value: "STT", label: "Students Tajik" },
        { value: "LNGSTUD", label: "Students Uzbek, Turkmen" },
        { value: "LSHMEDCL", label: "Work (Visa D) Uzbek, Turkmen" },
        { value: "LNGRSDTJK", label: "Work(D Visa) Tajik" },
      ]},
    ],
    "ind-deu": [
      { value: "BLR", label: "Bangalore - Germany Visa Application Centre", categories: [
        { value: "NV1", label: "Speciality Cook" },
        { value: "NVBA", label: "Basic or advanced in-company or school-based vocational training (§ 16a AufenthG)" },
        { value: "R124", label: "Conducting a quality analysis ((§ 16d Abs. 6 AufenthG)" },
      ]},
      { value: "COK", label: "Cochin - Visa Application Centre", categories: [
        { value: "NV1", label: "Speciality Cook" },
        { value: "NVBA", label: "Basic or advanced in-company or school-based vocational training (§ 16a AufenthG)" },
        { value: "R124", label: "Conducting a quality analysis ((§ 16d Abs. 6 AufenthG)" },
      ]},
    ],
  };

  var manualApplicantRoutes = { "egy-prt": true, "ind-deu": true };
  var manualApplicantFieldIds = ["firstName", "lastName", "dateOfBirth", "passportNumber", "dialCode", "contactNumber"];
  var indDeuUppercaseFieldIds = ["firstName", "lastName", "passportNumber"];

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
    var dialWrap = document.getElementById("manualDialContactFields");
    var route = getRouteKey();
    if (dialWrap) dialWrap.style.display = route === "egy-prt" ? "" : "none";
    if (route === "ind-deu") {
      var dEl = document.getElementById("dialCode");
      var cEl = document.getElementById("contactNumber");
      if (dEl) dEl.value = "";
      if (cEl) cEl.value = "";
    }
    updateIndDeuHiddenExtras();
    updateIndDeuUppercaseStyle();
  }

  function updateIndDeuHiddenExtras() {
    var on = getRouteKey() === "ind-deu";
    var loginWrap = document.getElementById("vfsLoginFields");
    if (loginWrap) loginWrap.style.display = on ? "none" : "";
    var acct2 = document.getElementById("loginAccount2Fields");
    if (acct2) acct2.style.display = on ? "none" : "";
    var center2 = document.getElementById("center2Fields");
    if (center2) center2.style.display = on ? "none" : "";
    if (!on) return;
    var u2 = document.getElementById("vfsUsername2");
    var p2 = document.getElementById("vfsPassword2");
    var v2 = document.getElementById("vacCode2");
    var c2 = document.getElementById("selectedSubvisaCategory2");
    if (u2) u2.value = "";
    if (p2) p2.value = "";
    if (v2) v2.value = "";
    if (c2) {
      c2.innerHTML = "";
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "-- Select Category --";
      c2.appendChild(ph);
    }
  }

  function updateIndDeuUppercaseStyle() {
    var on = getRouteKey() === "ind-deu";
    for (var i = 0; i < indDeuUppercaseFieldIds.length; i++) {
      var el = document.getElementById(indDeuUppercaseFieldIds[i]);
      if (el) el.style.textTransform = on ? "uppercase" : "";
    }
  }

  function forceIndDeuUppercaseInput(el) {
    if (!el || getRouteKey() !== "ind-deu") return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    var next = String(el.value || "").toUpperCase();
    if (el.value !== next) {
      el.value = next;
      if (typeof start === "number" && typeof end === "number") {
        try { el.setSelectionRange(start, end); } catch (e) {}
      }
    }
  }

  function wireIndDeuUppercaseInputs() {
    for (var i = 0; i < indDeuUppercaseFieldIds.length; i++) {
      var el = document.getElementById(indDeuUppercaseFieldIds[i]);
      if (!el || el.dataset.indDeuUpper === "1") continue;
      el.dataset.indDeuUpper = "1";
      el.addEventListener("input", function () { forceIndDeuUppercaseInput(this); });
    }
  }

  function updateIndLvaExtraFields() {
    var wrap = document.getElementById("indLvaExtraFields");
    if (!wrap) return;
    wrap.style.display = getRouteKey() === "ind-lva" ? "" : "none";
  }

  function updateUzbLvaApplicantFields() {
    var wrap = document.getElementById("uzbLvaApplicantFields");
    if (!wrap) return;
    wrap.style.display = getRouteKey() === "uzb-lva" ? "" : "none";
  }

  var uzbLvaFieldIds = ["firstNameUzbLva", "lastNameUzbLva", "passportNumberUzbLva"];

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
    updateIndLvaExtraFields();
    updateUzbLvaApplicantFields();
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

    // Auto-select the only center for the primary slot when nothing was previously picked,
    // so single-center portals (e.g. uzb-lva) don't require an extra click.
    if (!prevVac1 && centers.length === 1) {
      var vac1El = document.getElementById("vacCode");
      if (vac1El) vac1El.value = centers[0].value;
    }

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

    // Auto-select the only category for the primary slot when nothing was previously picked.
    if (centerSelectId === "vacCode" && !prevCat && categories.length === 1) {
      var catEl = document.getElementById(categorySelectId);
      if (catEl) catEl.value = categories[0].value;
    }
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
        "helloVerifyNumber",
        "juridictionCode",
      ].concat(manualApplicantFieldIds).concat(uzbLvaFieldIds);
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
      "helloVerifyNumber",
      "juridictionCode",
    ].concat(manualApplicantFieldIds).concat(uzbLvaFieldIds);
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
      var loadCredRoute = String((inst.details && inst.details.countryCode) || "") + "-" + String((inst.details && inst.details.missionCode) || "");
      if (loadCredRoute !== "ind-deu") {
        if (uEl) uEl.value = inst.credentials.username || "";
        if (pEl) pEl.value = inst.credentials.password || "";
        if (u2El) u2El.value = inst.credentials.username2 != null ? String(inst.credentials.username2) : "";
        if (p2El) p2El.value = inst.credentials.password2 != null ? String(inst.credentials.password2) : "";
      } else {
        if (uEl) uEl.value = "";
        if (pEl) pEl.value = "";
        if (u2El) u2El.value = "";
        if (p2El) p2El.value = "";
      }
    }

    if (inst.details) {
      const skipDetailIds = { numInstances: true, instanceId: true, vfsUsername2: true, vfsPassword2: true, countryCode: true, missionCode: true };
      var loadRouteKey = String(inst.details.countryCode || "") + "-" + String(inst.details.missionCode || "");
      if (loadRouteKey === "ind-deu") {
        skipDetailIds.dialCode = true;
        skipDetailIds.contactNumber = true;
        skipDetailIds.vacCode2 = true;
        skipDetailIds.selectedSubvisaCategory2 = true;
      }
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
        if (k === "calendarPollingStartDate" || k === "calendarPollingInterval") continue;
        const el = document.getElementById(k);
        if (el) el.value = inst.details[k] == null ? "" : String(inst.details[k]);
      }
      var vc1El = document.getElementById("vacCode");
      if (vc1El && inst.details.vacCode) vc1El.value = String(inst.details.vacCode);
      updateCategoryOptions("vacCode", "selectedSubvisaCategory");
      var sc1El = document.getElementById("selectedSubvisaCategory");
      if (sc1El && inst.details.selectedSubvisaCategory) sc1El.value = String(inst.details.selectedSubvisaCategory);
      if (loadRouteKey !== "ind-deu") {
        var vc2El = document.getElementById("vacCode2");
        if (vc2El && inst.details.vacCode2) vc2El.value = String(inst.details.vacCode2);
        updateCategoryOptions("vacCode2", "selectedSubvisaCategory2");
        var sc2El = document.getElementById("selectedSubvisaCategory2");
        if (sc2El && inst.details.selectedSubvisaCategory2) sc2El.value = String(inst.details.selectedSubvisaCategory2);
      }

      var routeKeyForLoad = loadRouteKey;
      if (routeKeyForLoad === "ind-deu") {
        for (var pi = 0; pi < indDeuUppercaseFieldIds.length; pi++) {
          var upperEl = document.getElementById(indDeuUppercaseFieldIds[pi]);
          if (upperEl && inst.details[indDeuUppercaseFieldIds[pi]]) {
            upperEl.value = String(inst.details[indDeuUppercaseFieldIds[pi]]).toUpperCase();
          }
        }
      }
      if (routeKeyForLoad === "uzb-lva") {
        var fnUzb = document.getElementById("firstNameUzbLva");
        if (fnUzb && inst.details.firstName) fnUzb.value = String(inst.details.firstName);
        var lnUzb = document.getElementById("lastNameUzbLva");
        if (lnUzb && inst.details.lastName) lnUzb.value = String(inst.details.lastName);
        var pnUzb = document.getElementById("passportNumberUzbLva");
        if (pnUzb && inst.details.passportNumber) pnUzb.value = String(inst.details.passportNumber);
      }
    }
    updateIndLvaExtraFields();
    updateUzbLvaApplicantFields();
    updateManualApplicantFields();
    applyInstanceScheduleRangeToForm(inst.details || {});

    // Global settings (instance 0): postLoginPollDelay + staggerIntervalSec + apologiesIntervalSec + calendar polling.
    const globalInst = data.instances["0"];
    const plpdEl = document.getElementById("postLoginPollDelay");
    if (plpdEl) {
      const src = (globalInst && globalInst.details) || (inst && inst.details) || {};
      plpdEl.value = src.postLoginPollDelay != null ? String(src.postLoginPollDelay) : "30";
    }
    const aisEl = document.getElementById("apologiesIntervalSec");
    if (aisEl) {
      const gsrc = (globalInst && globalInst.details) || {};
      const sec = gsrc.apologiesIntervalSec != null ? gsrc.apologiesIntervalSec : gsrc.applicantsIntervalSec;
      aisEl.value = sec != null ? String(sec) : "2";
    }
    const ajsEl = document.getElementById("applicantsJoinStaggerSec");
    if (ajsEl) {
      const gsrc = (globalInst && globalInst.details) || {};
      ajsEl.value = gsrc.applicantsJoinStaggerSec != null ? String(gsrc.applicantsJoinStaggerSec) : "0.5";
    }
    const sisEl = document.getElementById("staggerIntervalSec");
    if (sisEl) {
      const gsrc = (globalInst && globalInst.details) || {};
      sisEl.value = gsrc.staggerIntervalSec != null ? String(gsrc.staggerIntervalSec) : "6";
    }
    const cpsdEl = document.getElementById("calendarPollingStartDate");
    if (cpsdEl) {
      const gsrc = (globalInst && globalInst.details) || {};
      cpsdEl.value = gsrc.calendarPollingStartDate != null ? String(gsrc.calendarPollingStartDate).trim().slice(0, 10) : "";
    }
    const cpiEl = document.getElementById("calendarPollingInterval");
    if (cpiEl) {
      const gsrc = (globalInst && globalInst.details) || {};
      cpiEl.value = gsrc.calendarPollingInterval != null ? String(gsrc.calendarPollingInterval) : "60";
    }

    if (showAlert) {
      alert("Loaded saved data for Instance " + instanceId);
    }
  }

  async function saveFormData(showFeedback) {
    const form = document.getElementById("f");
    const fd = new FormData(form);
    const cc = String(fd.get("countryCode") || "ind");
    const mc = String(fd.get("missionCode") || "bgr");
    const isUzbLva = cc + "-" + mc === "uzb-lva";
    const isIndDeu = cc + "-" + mc === "ind-deu";
    const firstNameRaw = isUzbLva
      ? String(fd.get("firstNameUzbLva") || "").trim()
      : String(fd.get("firstName") || "").trim();
    const lastNameRaw = isUzbLva
      ? String(fd.get("lastNameUzbLva") || "").trim()
      : String(fd.get("lastName") || "").trim();
    const passportRaw = isUzbLva
      ? String(fd.get("passportNumberUzbLva") || "").trim()
      : String(fd.get("passportNumber") || "").trim();
    const firstNameSave = isIndDeu ? firstNameRaw.toUpperCase() : firstNameRaw;
    const lastNameSave = isIndDeu ? lastNameRaw.toUpperCase() : lastNameRaw;
    const passportSave = isIndDeu ? passportRaw.toUpperCase() : passportRaw;
    const body = {
      countryCode: cc,
      missionCode: mc,
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: String(fd.get("nationalityCode") || "").trim(),
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: isIndDeu ? undefined : (fd.get("vacCode2") || undefined),
      selectedSubvisaCategory2: isIndDeu ? undefined : (fd.get("selectedSubvisaCategory2") || undefined),
      firstName: firstNameSave || undefined,
      lastName: lastNameSave || undefined,
      dateOfBirth: String(fd.get("dateOfBirth") || "").trim() || undefined,
      passportNumber: passportSave || undefined,
      dialCode: isIndDeu ? undefined : (String(fd.get("dialCode") || "").trim() || undefined),
      contactNumber: isIndDeu ? undefined : (String(fd.get("contactNumber") || "").trim() || undefined),
      scheduleDateRangeStart: String(fd.get("scheduleDateRangeStart") ?? "").trim(),
      scheduleDateRangeEnd: String(fd.get("scheduleDateRangeEnd") ?? "").trim(),
      numInstances: getNumInstances(),
      userPollInterval: parseInt(String(fd.get("userPollInterval") || "60"), 10) || 60,
      apologiesIntervalSec: parseInt(String(fd.get("apologiesIntervalSec") || "2"), 10) || 2,
      applicantsJoinStaggerSec: parseFloat(String(fd.get("applicantsJoinStaggerSec") || "0.5")) || 0.5,
      calendarPollingStartDate: String(fd.get("calendarPollingStartDate") ?? "").trim(),
      calendarPollingInterval: parseInt(String(fd.get("calendarPollingInterval") || "60"), 10) || 60,
      postLoginPollDelay: parseInt(String(fd.get("postLoginPollDelay") || "30"), 10),
      staggerIntervalSec: parseInt(String(fd.get("staggerIntervalSec") || "6"), 10),
      instanceId: parseInt(String(fd.get("instanceId") || "1"), 10),
      helloVerifyNumber: String(fd.get("helloVerifyNumber") ?? "").trim() || undefined,
      juridictionCode: String(fd.get("juridictionCode") ?? "").trim() || undefined,
    };
    if (!Number.isFinite(body.postLoginPollDelay) || body.postLoginPollDelay < 0) body.postLoginPollDelay = 30;
    if (!Number.isFinite(body.apologiesIntervalSec) || body.apologiesIntervalSec < 1) body.apologiesIntervalSec = 2;
    if (!Number.isFinite(body.applicantsJoinStaggerSec) || body.applicantsJoinStaggerSec < 0.1) body.applicantsJoinStaggerSec = 0.5;
    if (!Number.isFinite(body.calendarPollingInterval) || body.calendarPollingInterval < 1) body.calendarPollingInterval = 60;
    if (collectLogin && !isIndDeu) {
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
          updateManualApplicantFields();
          updateIndLvaExtraFields();
          updateUzbLvaApplicantFields();
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
      wireIndDeuUppercaseInputs();

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
    } catch {
      // ignore
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

  function setSubmitLoading(on) {
    const btn = document.getElementById("submitBtn");
    if (!btn) return;
    if (on) {
      if (!btn.dataset.prevLabel) btn.dataset.prevLabel = btn.textContent || "Submit & Run";
      btn.disabled = true;
      btn.classList.add("is-loading");
      btn.textContent = "Starting\\u2026";
    } else {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.textContent = btn.dataset.prevLabel || "Submit & Run";
      delete btn.dataset.prevLabel;
    }
  }

  /** Poll monitor until any instance reports Chrome DevTools up (first window open). */
  async function waitForFirstChrome(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 180000);
    let consecutiveMisses = 0;
    while (Date.now() < deadline) {
      try {
        const r = await fetch("/api/monitor/snapshot");
        if (!r.ok) {
          consecutiveMisses += 1;
          if (consecutiveMisses >= 3) return false;
        } else {
          consecutiveMisses = 0;
          const d = await r.json();
          if (d && d.ok && Array.isArray(d.instances)) {
            for (let i = 0; i < d.instances.length; i++) {
              if (d.instances[i].chromeAlive === true) return true;
            }
          }
        }
      } catch {
        consecutiveMisses += 1;
        if (consecutiveMisses >= 5) return false;
      }
      await new Promise(function (res) { setTimeout(res, 400); });
    }
    return false;
  }

  document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    const msg = document.getElementById("msg");
    msg.textContent = "";
    const fd = new FormData(e.target);
    const cc = String(fd.get("countryCode") || "ind");
    const mc = String(fd.get("missionCode") || "bgr");
    const isUzbLva = cc + "-" + mc === "uzb-lva";
    const isIndDeu = cc + "-" + mc === "ind-deu";
    const firstNameRaw = isUzbLva
      ? String(fd.get("firstNameUzbLva") || "").trim()
      : String(fd.get("firstName") || "").trim();
    const lastNameRaw = isUzbLva
      ? String(fd.get("lastNameUzbLva") || "").trim()
      : String(fd.get("lastName") || "").trim();
    const passportRaw = isUzbLva
      ? String(fd.get("passportNumberUzbLva") || "").trim()
      : String(fd.get("passportNumber") || "").trim();
    const firstNameSave = isIndDeu ? firstNameRaw.toUpperCase() : firstNameRaw;
    const lastNameSave = isIndDeu ? lastNameRaw.toUpperCase() : lastNameRaw;
    const passportSave = isIndDeu ? passportRaw.toUpperCase() : passportRaw;
    const nationalityRaw = String(fd.get("nationalityCode") || "").trim();
    const vacCodeRaw = String(fd.get("vacCode") || "").trim();
    const subvisaRaw = String(fd.get("selectedSubvisaCategory") || "").trim();
    const dobRaw = String(fd.get("dateOfBirth") || "").trim();
    const expiryRaw = String(fd.get("passportExpirtyDate") || "").trim();

    const missing = [];
    if (!vacCodeRaw) missing.push("Visa Application Centre");
    if (!subvisaRaw) missing.push("Visa Category");
    if (isUzbLva) {
      if (!firstNameRaw) missing.push("First name");
      if (!lastNameRaw) missing.push("Last name");
      if (!nationalityRaw) missing.push("Nationality");
      if (!passportRaw) missing.push("Passport number");
    }
    if (isIndDeu) {
      if (!firstNameSave) missing.push("First name");
      if (!lastNameSave) missing.push("Last name");
      if (!dobRaw) missing.push("Date of birth");
      if (!nationalityRaw) missing.push("Nationality");
      if (!passportSave) missing.push("Passport number");
      if (!expiryRaw) missing.push("Passport expiry");
    }
    if (missing.length > 0) {
      msg.className = "err";
      msg.textContent = "Please fill required fields: " + missing.join(", ");
      return;
    }

    const body = {
      countryCode: cc,
      missionCode: mc,
      passportExpirtyDate: fd.get("passportExpirtyDate"),
      nationalityCode: nationalityRaw,
      vacCode: fd.get("vacCode"),
      gender: parseInt(String(fd.get("gender") || "1"), 10),
      selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
      vacCode2: isIndDeu ? undefined : (fd.get("vacCode2") || undefined),
      selectedSubvisaCategory2: isIndDeu ? undefined : (fd.get("selectedSubvisaCategory2") || undefined),
      firstName: firstNameSave || undefined,
      lastName: lastNameSave || undefined,
      dateOfBirth: dobRaw || undefined,
      passportNumber: passportSave || undefined,
      dialCode: isIndDeu ? undefined : (String(fd.get("dialCode") || "").trim() || undefined),
      contactNumber: isIndDeu ? undefined : (String(fd.get("contactNumber") || "").trim() || undefined),
      scheduleDateRangeStart: String(fd.get("scheduleDateRangeStart") ?? "").trim(),
      scheduleDateRangeEnd: String(fd.get("scheduleDateRangeEnd") ?? "").trim(),
      numInstances: getNumInstances(),
      userPollInterval: parseInt(String(fd.get("userPollInterval") || "60"), 10) || 60,
      apologiesIntervalSec: parseInt(String(fd.get("apologiesIntervalSec") || "2"), 10) || 2,
      applicantsJoinStaggerSec: parseFloat(String(fd.get("applicantsJoinStaggerSec") || "0.5")) || 0.5,
      calendarPollingStartDate: String(fd.get("calendarPollingStartDate") ?? "").trim(),
      calendarPollingInterval: parseInt(String(fd.get("calendarPollingInterval") || "60"), 10) || 60,
      postLoginPollDelay: parseInt(String(fd.get("postLoginPollDelay") || "30"), 10),
      staggerIntervalSec: parseInt(String(fd.get("staggerIntervalSec") || "6"), 10),
      instanceId: parseInt(String(fd.get("instanceId") || "1"), 10),
      helloVerifyNumber: String(fd.get("helloVerifyNumber") ?? "").trim() || undefined,
      juridictionCode: String(fd.get("juridictionCode") ?? "").trim() || undefined,
    };
    if (!Number.isFinite(body.postLoginPollDelay) || body.postLoginPollDelay < 0) body.postLoginPollDelay = 30;
    if (!Number.isFinite(body.apologiesIntervalSec) || body.apologiesIntervalSec < 1) body.apologiesIntervalSec = 2;
    if (!Number.isFinite(body.applicantsJoinStaggerSec) || body.applicantsJoinStaggerSec < 0.1) body.applicantsJoinStaggerSec = 0.5;
    if (!Number.isFinite(body.calendarPollingInterval) || body.calendarPollingInterval < 1) body.calendarPollingInterval = 60;
    if (collectLogin && !isIndDeu) {
      body.vfsUsername = fd.get("vfsUsername");
      body.vfsPassword = fd.get("vfsPassword");
      body.vfsUsername2 = fd.get("vfsUsername2");
      body.vfsPassword2 = fd.get("vfsPassword2");
    }
    setSubmitLoading(true);
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
          "\\u2713 Started " + (j.queued || "all") + " bot instance(s). Waiting for Chrome\\u2026";
        await waitForFirstChrome(180000);
        msg.textContent =
          "\\u2713 Started " + (j.queued || "all") + " bot instance(s). Check terminal for progress.";
      } else {
        msg.className = "err";
        msg.textContent = j.error || "Submit failed";
      }
    } catch (err) {
      msg.className = "err";
      msg.textContent = String(err);
    } finally {
      setSubmitLoading(false);
    }
  });

  document.getElementById("forceBookBtn").addEventListener("click", async function () {
    const msg = document.getElementById("msg");
    const btn = document.getElementById("forceBookBtn");
    msg.textContent = "";
    btn.disabled = true;
    btn.textContent = "Booking...";
    try {
      const r = await fetch("/api/force-book", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      if (j.ok) {
        msg.className = "ok";
        msg.textContent = "\\u2713 Force booking triggered for " + (j.queued || "all") + " instance(s). Check terminal.";
      } else {
        msg.className = "err";
        msg.textContent = j.error || "Force book failed";
      }
    } catch (err) {
      msg.className = "err";
      msg.textContent = String(err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Book Slot";
    }
  });
})();
</script>`;
}
