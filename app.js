/* =========================================================
   DREAM HOME v3
   Public View + Owner Editing + Supabase Cloud Sync
   ========================================================= */

const CFG = window.DREAM_HOME || {};

const ready =
  CFG.url &&
  !CFG.url.includes("PASTE_") &&
  CFG.key &&
  !CFG.key.includes("PASTE_");

const db = ready
  ? supabase.createClient(CFG.url, CFG.key)
  : null;

let user = null;
let loan = null;
let bs = [];
let ps = [];

const $ = id => document.getElementById(id);

const M = n =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(n) || 0));

const N = n =>
  Number(n || 0);

const esc = x =>
  String(x ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function toast(message, type = "normal") {
  let t = $("toast");

  if (!t) return;

  t.className = `toast-message ${type}`;
  t.innerHTML = `
    <div class="toast-icon">
      ${type === "success" ? "✓" : type === "error" ? "!" : "i"}
    </div>
    <div>${esc(message)}</div>
  `;

  t.style.display = "flex";

  clearTimeout(window.__toastTimer);

  window.__toastTimer = setTimeout(() => {
    t.style.opacity = "0";

    setTimeout(() => {
      t.style.display = "none";
      t.style.opacity = "1";
    }, 250);
  }, 2600);
}


function sync(status) {
  const s = $("sync");

  if (!s) return;

  s.className =
    status === "ok"
      ? "ok"
      : status === "bad"
      ? "bad"
      : "";

  s.title =
    status === "ok"
      ? "Cloud backup connected"
      : status === "bad"
      ? "Cloud backup problem"
      : "Connecting to cloud...";
}


function isOwner() {
  return !!user && !!loan && loan.created_by === user.id;
}


function monthlyRate() {
  return N(loan?.annual_rate) / 1200;
}


function formatMonth(date) {
  const d = new Date(date);

  if (isNaN(d)) return "";

  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}


function monthDate(monthNo) {
  if (!loan?.start_date) return null;

  const d = new Date(`${loan.start_date}T00:00:00`);

  d.setMonth(d.getMonth() + Number(monthNo) - 1);

  return d;
}


function monthLabel(monthNo) {
  const d = monthDate(monthNo);

  return d ? formatMonth(d) : `Month ${monthNo}`;
}


function totalFixedEMI() {
  if (!loan) return 0;

  if (loan.emi_mode === "manual") {
    return N(loan.manual_emi);
  }

  const p = N(loan.total_amount);
  const n = N(loan.tenure_months);
  const r = monthlyRate();

  if (!p || !n) return 0;

  if (!r) return p / n;

  return (
    p *
    r *
    Math.pow(1 + r, n) /
    (Math.pow(1 + r, n) - 1)
  );
}


/* =========================================================
   PAYMENT LOOKUP
   ========================================================= */

function paymentFor(monthNo, borrowerId) {
  return (
    ps.find(
      x =>
        Number(x.month_no) === Number(monthNo) &&
        x.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0,
      payment_date: null
    }
  );
}


/* =========================================================
   LOAN CALCULATION
   =========================================================

   Important:
   - There is NO borrower principal share.
   - Interest is calculated on FULL remaining loan.
   - Fixed EMI is the normal EMI.
   - Extra principal belongs entirely to the person who paid it.
   - During interest-only months, normal EMI does not reduce
     principal.
   - Extra principal always reduces principal.
   ========================================================= */

function calculateLoan(uptoMonth = loan?.tenure_months || 0) {
  if (!loan) {
    return {
      principal: 0,
      interestPaid: 0,
      regularPrincipalPaid: 0,
      extraPrincipalPaid: 0,
      totalPaid: 0,
      remaining: 0,
      unpaidInterest: 0,
      monthsPaid: 0,
      monthsElapsed: 0
    };
  }

  let balance = N(loan.total_amount);
  let interestPaid = 0;
  let regularPrincipalPaid = 0;
  let extraPrincipalPaid = 0;
  let totalPaid = 0;
  let unpaidInterest = 0;
  let monthsPaid = 0;

  const r = monthlyRate();
  const fixedEMI = totalFixedEMI();
  const interestOnly = N(loan.interest_only_months);

  for (let m = 1; m <= uptoMonth; m++) {
    if (balance <= 0.01) break;

    const monthPayments = ps.filter(
      x => Number(x.month_no) === m
    );

    const regularPaid = monthPayments.reduce(
      (sum, x) => sum + N(x.emi_paid),
      0
    );

    const extraPaid = monthPayments.reduce(
      (sum, x) => sum + N(x.extra_principal),
      0
    );

    const interest = balance * r;

    totalPaid += regularPaid + extraPaid;

    if (
      regularPaid > 0 ||
      extraPaid > 0
    ) {
      monthsPaid = m;
    }

    /*
      Normal EMI:
      First interest-only months -> all normal EMI is treated
      as interest.

      After interest-only period:
      EMI pays interest first and remaining amount reduces
      principal.
    */

    let regularPrincipal = 0;

    if (m > interestOnly) {
      regularPrincipal = Math.min(
        Math.max(0, regularPaid - interest),
        balance
      );
    }

    const interestComponent = Math.min(
      regularPaid,
      interest
    );

    interestPaid += interestComponent;

    unpaidInterest += Math.max(
      0,
      interest - regularPaid
    );

    balance -= regularPrincipal;

    regularPrincipalPaid += regularPrincipal;

    /*
      Extra principal always reduces the FULL loan principal.
    */

    const actualExtra = Math.min(
      Math.max(0, extraPaid),
      Math.max(0, balance)
    );

    balance -= actualExtra;

    extraPrincipalPaid += actualExtra;

    balance = Math.max(0, balance);
  }

  return {
    principal: N(loan.total_amount),
    interestPaid,
    regularPrincipalPaid,
    extraPrincipalPaid,
    totalPaid,
    remaining: balance,
    unpaidInterest,
    monthsPaid,
    monthsElapsed: uptoMonth
  };
}


/* =========================================================
   CURRENT LOAN STATUS
   ========================================================= */

function currentLoanStatus() {
  const months = [];

  ps.forEach(p => {
    if (
      N(p.emi_paid) > 0 ||
      N(p.extra_principal) > 0
    ) {
      if (!months.includes(Number(p.month_no))) {
        months.push(Number(p.month_no));
      }
    }
  });

  const lastMonth =
    months.length
      ? Math.max(...months)
      : 0;

  return {
    lastMonth,
    calc: calculateLoan(lastMonth)
  };
}


/* =========================================================
   REMAINING TENURE CALCULATION
   =========================================================

   Calculates how many months are required to clear the
   current remaining principal using the fixed EMI.

   Extra principal therefore automatically reduces tenure.
   ========================================================= */

function calculateRemainingTenure(balance) {
  balance = N(balance);

  if (balance <= 0.01) return 0;

  const r = monthlyRate();
  const emi = totalFixedEMI();

  if (!emi) return 0;

  if (!r) {
    return Math.ceil(balance / emi);
  }

  /*
    If EMI is not enough even to cover interest,
    the loan cannot amortize.
  */

  if (emi <= balance * r) {
    return Infinity;
  }

  const months =
    -Math.log(
      1 - (balance * r) / emi
    ) /
    Math.log(1 + r);

  return Math.ceil(months);
}


function projectedTotalTenure() {
  if (!loan) return 0;

  const status = currentLoanStatus();

  const remainingMonths =
    calculateRemainingTenure(
      status.calc.remaining
    );

  if (remainingMonths === Infinity) {
    return Infinity;
  }

  return status.lastMonth + remainingMonths;
}


function loanProgressPercent() {
  if (!loan) return 0;

  const status = currentLoanStatus();

  const paid =
    N(loan.total_amount) -
    N(status.calc.remaining);

  return Math.max(
    0,
    Math.min(
      100,
      (paid / N(loan.total_amount)) * 100
    )
  );
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function nav(id) {
  document
    .querySelectorAll(".screen")
    .forEach(x =>
      x.classList.remove("active")
    );

  const screen = $(id);

  if (screen) {
    screen.classList.add("active");
  }

  document
    .querySelectorAll("nav button")
    .forEach(x =>
      x.classList.toggle(
        "active",
        x.dataset.s === id
      )
    );

  const titles = {
    dashboard: "Dashboard",
    payments: "Payments",
    people: "People",
    reports: "Reports",
    more: "More"
  };

  if ($("title")) {
    $("title").textContent =
      titles[id] || "Dream Home";
  }

  if (id === "dashboard") dashboard();
  if (id === "payments") payments();
  if (id === "people") people();
  if (id === "reports") reports();
  if (id === "more") more();
}


document
  .querySelectorAll("nav button")
  .forEach(btn => {
    btn.onclick = () =>
      nav(btn.dataset.s);
  });


/* =========================================================
   ACCOUNT BUTTON
   ========================================================= */

const accountBtn = $("account");

if (accountBtn) {
  accountBtn.onclick = () => {
    accountPopup();
  };
}


/* =========================================================
   CLOUD LOAD
   ========================================================= */

async function load() {
  if (!db) {
    sync("bad");
    dashboard();
    return;
  }

  sync("");

  try {
    const auth = await db.auth.getUser();

    user = auth.data?.user || null;

    const l = await db
      .from("loans")
      .select("*")
      .order("created_at", {
        ascending: true
      })
      .limit(1)
      .maybeSingle();

    if (l.error) {
      console.error(l.error);
      toast(l.error.message, "error");
      sync("bad");
      return;
    }

    loan = l.data || null;

    if (loan) {
      const [b, p] =
        await Promise.all([
          db
            .from("borrowers")
            .select("*")
            .eq("loan_id", loan.id)
            .order("sort_order"),

          db
            .from("monthly_payments")
            .select("*")
            .eq("loan_id", loan.id)
            .order("month_no")
        ]);

      if (b.error) {
        toast(b.error.message, "error");
      }

      if (p.error) {
        toast(p.error.message, "error");
      }

      bs = b.data || [];
      ps = p.data || [];
    } else {
      bs = [];
      ps = [];
    }

    sync("ok");

    dashboard();

  } catch (e) {
    console.error(e);
    sync("bad");
    toast("Unable to connect to cloud.", "error");
  }
}


/* =========================================================
   DASHBOARD
   ========================================================= */

function dashboard() {
  if (!loan) {
    $("dashboard").innerHTML = `
      <div class="dh-empty">
        <div class="dh-logo">🏠</div>
        <h2>Dream Home</h2>
        <p>
          Your shared home loan tracker is ready.
        </p>
        <p class="muted">
          Tap the person icon above to sign in as owner.
        </p>
      </div>
    `;

    return;
  }

  const status = currentLoanStatus();
  const c = status.calc;

  const remaining = c.remaining;

  const paid =
    N(loan.total_amount) -
    remaining;

  const percent =
    loan.total_amount > 0
      ? (paid / loan.total_amount) * 100
      : 0;

  const fixedEMI = totalFixedEMI();

  const projected =
    projectedTotalTenure();

  const tenureText =
    projected === Infinity
      ? "Not amortizing"
      : `${projected} months`;

  const monthsPaid =
    status.lastMonth;

  const originalTenure =
    N(loan.tenure_months) || 0;

  const extra =
    c.extraPrincipalPaid;

  $("dashboard").innerHTML = `

    <div class="dh-hero">

      <div class="dh-hero-top">
        <div>
          <small>REMAINING PRINCIPAL</small>
          <div class="dh-big">
            ${M(remaining)}
          </div>
        </div>

        <div class="dh-house">
          🏠
        </div>
      </div>

      <div class="dh-progress">
        <div
          class="dh-progress-fill"
          style="width:${Math.max(
            0,
            Math.min(100, percent)
          )}%">
        </div>
      </div>

      <div class="dh-progress-text">
        <span>
          ${percent.toFixed(1)}% paid
        </span>
        <span>
          ${M(paid)} / ${M(loan.total_amount)}
        </span>
      </div>

    </div>


    <!-- FIXED EMI -->

    <div class="dh-fixed-card">

      <div>
        <small>MINIMUM EMI</small>
        <strong>${M(fixedEMI)}</strong>
      </div>

      <div class="dh-fixed-label">
        Fixed EMI
      </div>

    </div>


    <!-- QUICK METRICS -->

    <div class="dh-metrics">

      <div class="dh-metric">
        <span>EMIs Paid</span>
        <strong>
          ${monthsPaid} / ${originalTenure}
        </strong>
      </div>

      <div class="dh-metric">
        <span>Extra Principal</span>
        <strong>${M(extra)}</strong>
      </div>

      <div class="dh-metric">
        <span>Interest Paid</span>
        <strong>${M(c.interestPaid)}</strong>
      </div>

      <div class="dh-metric">
        <span>New Tenure</span>
        <strong>
          ${
            tenureText
          }
        </strong>
      </div>

    </div>


    <!-- EMI PROGRESS -->

    <div class="dh-card">

      <div class="dh-card-title">
        <div>
          <h3>EMI Progress</h3>
          <small>
            ${monthsPaid} EMI month${
              monthsPaid === 1 ? "" : "s"
            } recorded out of ${originalTenure}
          </small>
        </div>

        <div class="dh-round">
          ${Math.round(
            originalTenure
              ? (monthsPaid / originalTenure) * 100
              : 0
          )}%
        </div>
      </div>

      <div class="dh-progress light">
        <div
          class="dh-progress-fill"
          style="width:${Math.min(
            100,
            originalTenure
              ? (monthsPaid / originalTenure) * 100
              : 0
          )}%">
        </div>
      </div>

      <div class="dh-note">
        Extra principal reduces the remaining tenure automatically.
      </div>

    </div>


    <!-- OWNER ACTIONS -->

    ${
      isOwner()
        ? `
          <div class="dh-actions">

            <button
              class="dh-btn primary"
              onclick="payment()">
              <span>＋</span>
              Add Payment
            </button>

            <button
              class="dh-btn secondary"
              onclick="loanEdit()">
              <span>⚙</span>
              Loan Settings
            </button>

          </div>
        `
        : ""
    }


    <div class="dh-card dh-mini-info">

      <div>
        <small>LOAN</small>
        <strong>
          ${esc(
            loan.name ||
            "Dream Home Loan"
          )}
        </strong>
      </div>

      <div>
        <small>INTEREST</small>
        <strong>
          ${N(loan.annual_rate).toFixed(2)}%
        </strong>
      </div>

      <div>
        <small>START</small>
        <strong>
          ${
            loan.start_date
              ? formatMonth(
                  `${loan.start_date}T00:00:00`
                )
              : "-"
          }
        </strong>
      </div>

    </div>
  `;
}


/* =========================================================
   PAYMENTS PAGE
   ========================================================= */

function payments() {
  if (!loan) {
    $("payments").innerHTML = `
      <div class="dh-empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const months = [
    ...new Set(
      ps.map(x => Number(x.month_no))
    )
  ].sort((a, b) => a - b);

  $("payments").innerHTML = `

    <div class="dh-page-head">

      <div>
        <small>PAYMENT TRACKER</small>
        <h2>Payments</h2>
      </div>

      ${
        isOwner()
          ? `
            <button
              class="dh-btn primary small"
              onclick="payment()">
              ＋ Add
            </button>
          `
          : ""
      }

    </div>


    <div class="dh-card">

      ${
        months.length
          ? months
              .reverse()
              .map(m => paymentMonthCard(m))
              .join("")
          : `
            <div class="dh-empty-small">
              <div>💳</div>
              <b>No payments recorded</b>
              <span>
                ${
                  isOwner()
                    ? "Tap Add to record the first payment."
                    : "The owner has not added any payments yet."
                }
              </span>
            </div>
          `
      }

    </div>
  `;
}


function paymentMonthCard(monthNo) {
  const rows = ps.filter(
    x => Number(x.month_no) === Number(monthNo)
  );

  const emi = rows.reduce(
    (s, x) => s + N(x.emi_paid),
    0
  );

  const extra = rows.reduce(
    (s, x) => s + N(x.extra_principal),
    0
  );

  const total = emi + extra;

  return `
    <div class="dh-payment-month">

      <div class="dh-payment-header">

        <div>
          <small>PAYMENT MONTH</small>
          <h3>${esc(monthLabel(monthNo))}</h3>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="dh-icon-btn"
                onclick="editPayment(${monthNo})">
                ✎
              </button>
            `
            : ""
        }

      </div>

      <div class="dh-payment-summary">

        <div>
          <span>EMI Paid</span>
          <b>${M(emi)}</b>
        </div>

        <div>
          <span>Extra Principal</span>
          <b>${M(extra)}</b>
        </div>

        <div>
          <span>Total Paid</span>
          <b>${M(total)}</b>
        </div>

      </div>

      <div class="dh-payment-people">

        ${rows
          .map(x => {
            const person =
              bs.find(
                b => b.id === x.borrower_id
              );

            return `
              <div class="dh-person-line">

                <span>
                  ${esc(
                    person?.name ||
                    "Person"
                  )}
                </span>

                <span>
                  EMI ${M(x.emi_paid)}
                  ${
                    N(x.extra_principal)
                      ? ` · Extra ${M(
                          x.extra_principal
                        )}`
                      : ""
                  }
                </span>

              </div>
            `;
          })
          .join("")}

      </div>

    </div>
  `;
}


/* =========================================================
   ADD PAYMENT
   ========================================================= */

function payment() {
  if (!isOwner()) {
    return;
  }

  if (!bs.length) {
    toast(
      "Add borrowers first under People.",
      "error"
    );
    return;
  }

  const options = [];

  const maxMonth =
    Math.max(
      N(loan.tenure_months),
      ps.length
        ? Math.max(
            ...ps.map(x =>
              Number(x.month_no)
            )
          )
        : 0
    );

  /*
    Allow next months to be entered.
    Generate up to original tenure.
  */

  for (
    let m = 1;
    m <= N(loan.tenure_months);
    m++
  ) {
    options.push(`
      <option value="${m}">
        ${esc(monthLabel(m))}
      </option>
    `);
  }

  modal(`

    <div class="dh-modal-head">

      <div class="dh-modal-icon">
        💳
      </div>

      <div>
        <h2>Add Payment</h2>
        <p>
          Enter only the extra principal paid by each person.
        </p>
      </div>

    </div>

    <label>
      Payment Month

      <select id="pm">
        ${options.join("")}
      </select>

    </label>


    <div class="dh-info-box">

      <b>Fixed EMI: ${M(
        totalFixedEMI()
      )}</b>

      <span>
        Fixed EMI is automatically recorded for every
        person. You only need to enter extra principal.
      </span>

    </div>


    <div id="paymentPeople"></div>


    <button
      class="dh-btn primary full"
      onclick="savePayment()">
      ✓ Save Payment
    </button>

  `);

  renderPaymentPeople();
}


function renderPaymentPeople(
  monthNo = null
) {
  const container =
    $("paymentPeople");

  if (!container) return;

  const m =
    monthNo ||
    Number($("pm")?.value || 1);

  container.innerHTML = bs
    .map(b => {

      const existing =
        paymentFor(m, b.id);

      return `
        <div class="dh-entry">

          <div class="dh-entry-head">

            <div class="dh-avatar">
              ${esc(
                (b.name || "P")
                  .charAt(0)
                  .toUpperCase()
              )}
            </div>

            <div>
              <b>${esc(b.name)}</b>
              <small>
                Fixed EMI: ${M(
                  b.scheduled_emi ||
                  totalFixedEMI() /
                    Math.max(bs.length, 1)
                )}
              </small>
            </div>

          </div>


          <label>
            Extra Principal

            <input
              id="extra_${esc(b.id)}"
              type="number"
              min="0"
              step="1"
              value="${
                N(
                  existing.extra_principal
                ) || ""
              }"
              placeholder="₹ 0"
            />

          </label>

          <small class="dh-field-note">
            This extra amount belongs entirely to
            ${esc(b.name)}.
          </small>

        </div>
      `;
    })
    .join("");

  const select = $("pm");

  if (select) {
    select.onchange = () => {
      renderPaymentPeople(
        Number(select.value)
      );
    };
  }
}


/* =========================================================
   SAVE PAYMENT
   ========================================================= */

async function savePayment() {
  if (!isOwner()) return;

  const monthNo =
    Number($("pm")?.value || 0);

  if (!monthNo) {
    toast(
      "Please select a payment month.",
      "error"
    );
    return;
  }

  const fixed =
    totalFixedEMI();

  /*
    Fixed EMI is divided equally among people
    unless individual scheduled EMI has already been
    configured.

    Existing scheduled_emi values are respected.
  */

  const totalConfigured =
    bs.reduce(
      (s, b) =>
        s +
        N(
          b.scheduled_emi
        ),
      0
    );

  const defaultEach =
    bs.length
      ? fixed / bs.length
      : 0;

  for (const b of bs) {

    const input =
      $(`extra_${b.id}`);

    const extra =
      Math.max(
        0,
        N(input?.value)
      );

    /*
      If person EMI is configured use it.
      Otherwise equally divide fixed EMI.
    */

    const personEMI =
      totalConfigured > 0
        ? N(b.scheduled_emi)
        : defaultEach;

    const existing =
      paymentFor(
        monthNo,
        b.id
      );

    const row = {
      loan_id: loan.id,
      borrower_id: b.id,
      month_no: monthNo,
      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),
      emi_paid: personEMI,
      extra_principal: extra
    };

    let q;

    if (
      existing &&
      ps.some(
        x =>
          Number(x.month_no) === monthNo &&
          x.borrower_id === b.id
      )
    ) {

      q = await db
        .from("monthly_payments")
        .update(row)
        .eq("loan_id", loan.id)
        .eq("borrower_id", b.id)
        .eq("month_no", monthNo);

    } else {

      q = await db
        .from("monthly_payments")
        .insert(row);
    }

    if (q.error) {
      console.error(q.error);
      toast(
        q.error.message,
        "error"
      );
      return;
    }
  }

  close();

  await load();

  toast(
    `${monthLabel(monthNo)} payment saved`,
    "success"
  );

  nav("dashboard");
}


/* =========================================================
   EDIT PAYMENT
   ========================================================= */

function editPayment(monthNo) {
  if (!isOwner()) return;

  modal(`

    <div class="dh-modal-head">

      <div class="dh-modal-icon">
        ✎
      </div>

      <div>
        <h2>Edit Payment</h2>
        <p>
          ${esc(monthLabel(monthNo))}
        </p>
      </div>

    </div>


    <div id="editPaymentPeople"></div>


    <div class="dh-edit-actions">

      <button
        class="dh-btn primary"
        onclick="updatePayment(${monthNo})">
        ✓ Update
      </button>

      <button
        class="dh-btn danger"
        onclick="deletePayment(${monthNo})">
        🗑 Delete Month
      </button>

    </div>

  `);

  const container =
    $("editPaymentPeople");

  container.innerHTML = bs
    .map(b => {

      const p =
        ps.find(
          x =>
            Number(x.month_no) ===
              Number(monthNo) &&
            x.borrower_id === b.id
        );

      return `
        <div class="dh-entry">

          <div class="dh-entry-head">

            <div class="dh-avatar">
              ${esc(
                (b.name || "P")
                  .charAt(0)
                  .toUpperCase()
              )}
            </div>

            <div>
              <b>${esc(b.name)}</b>
              <small>
                Fixed EMI: ${M(
                  N(b.scheduled_emi)
                )}
              </small>
            </div>

          </div>


          <div class="dh-edit-grid">

            <div>
              <label>EMI Paid</label>
              <input
                disabled
                value="${M(
                  N(
                    p?.emi_paid ||
                    b.scheduled_emi
                  )
                )}">
            </div>

            <div>
              <label>Extra Principal</label>
              <input
                id="edit_extra_${esc(
                  b.id
                )}"
                type="number"
                min="0"
                step="1"
                value="${
                  N(
                    p?.extra_principal
                  ) || ""
                }"
                placeholder="₹ 0">
            </div>

          </div>

        </div>
      `;
    })
    .join("");
}


async function updatePayment(monthNo) {
  if (!isOwner()) return;

  for (const b of bs) {

    const input =
      $(
        `edit_extra_${b.id}`
      );

    const extra =
      Math.max(
        0,
        N(input?.value)
      );

    const existing =
      ps.find(
        x =>
          Number(x.month_no) ===
            Number(monthNo) &&
          x.borrower_id === b.id
      );

    const emi =
      existing
        ? N(existing.emi_paid)
        : N(b.scheduled_emi);

    const row = {
      loan_id: loan.id,
      borrower_id: b.id,
      month_no: monthNo,
      payment_date:
        existing?.payment_date ||
        new Date()
          .toISOString()
          .slice(0, 10),
      emi_paid: emi,
      extra_principal: extra
    };

    const q =
      await db
        .from("monthly_payments")
        .upsert(
          row,
          {
            onConflict:
              "loan_id,borrower_id,month_no"
          }
        );

    if (q.error) {
      toast(
        q.error.message,
        "error"
      );
      return;
    }
  }

  close();

  await load();

  toast(
    `${monthLabel(monthNo)} updated`,
    "success"
  );

  nav("payments");
}


/* =========================================================
   DELETE PAYMENT MONTH
   ========================================================= */

async function deletePayment(monthNo) {
  if (!isOwner()) return;

  if (
    !confirm(
      `Delete all payments for ${monthLabel(
        monthNo
      )}?`
    )
  ) {
    return;
  }

  const q =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id)
      .eq("month_no", monthNo);

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    `${monthLabel(monthNo)} deleted`,
    "success"
  );

  nav("payments");
}


/* =========================================================
   PEOPLE
   ========================================================= */

function people() {
  if (!loan) {
    $("people").innerHTML = `
      <div class="dh-empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  $("people").innerHTML = `

    <div class="dh-page-head">

      <div>
        <small>MEMBERS</small>
        <h2>People</h2>
      </div>

      ${
        isOwner()
          ? `
            <button
              class="dh-btn primary small"
              onclick="person()">
              ＋ Add
            </button>
          `
          : ""
      }

    </div>


    <div class="dh-card">

      ${
        bs.length
          ? bs
              .map(b => personCard(b))
              .join("")
          : `
            <div class="dh-empty-small">
              <div>👥</div>
              <b>No people added</b>
              <span>
                ${
                  isOwner()
                    ? "Add the four loan members."
                    : "No members have been added yet."
                }
              </span>
            </div>
          `
      }

    </div>
  `;
}


function personCard(b) {
  let emiPaid = 0;
  let extra = 0;

  ps
    .filter(
      x => x.borrower_id === b.id
    )
    .forEach(x => {
      emiPaid += N(x.emi_paid);
      extra += N(x.extra_principal);
    });

  const total =
    emiPaid + extra;

  const overallPaid =
    ps.reduce(
      (s, x) =>
        s +
        N(x.emi_paid) +
        N(x.extra_principal),
      0
    );

  const contribution =
    overallPaid
      ? (total / overallPaid) * 100
      : 0;

  return `

    <div class="dh-person-card">

      <div class="dh-person-top">

        <div class="dh-avatar big">
          ${esc(
            (b.name || "P")
              .charAt(0)
              .toUpperCase()
          )}
        </div>

        <div class="dh-person-name">
          <b>${esc(b.name)}</b>
          <small>
            Fixed EMI ${M(
              N(b.scheduled_emi)
            )}
          </small>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="dh-icon-btn"
                onclick="person('${b.id}')">
                ✎
              </button>
            `
            : ""
        }

      </div>


      <div class="dh-person-stats">

        <div>
          <span>EMI Paid</span>
          <b>${M(emiPaid)}</b>
        </div>

        <div>
          <span>Extra Principal</span>
          <b>${M(extra)}</b>
        </div>

        <div>
          <span>Total Paid</span>
          <b>${M(total)}</b>
        </div>

        <div>
          <span>Contribution</span>
          <b>${contribution.toFixed(1)}%</b>
        </div>

      </div>

    </div>
  `;
}


/* =========================================================
   ADD / EDIT PERSON
   ========================================================= */

function person(id) {
  if (!isOwner()) return;

  const b =
    bs.find(
      x => x.id === id
    ) || {
      name: "",
      scheduled_emi: 0
    };

  modal(`

    <div class="dh-modal-head">

      <div class="dh-modal-icon">
        👤
      </div>

      <div>
        <h2>
          ${id ? "Edit Person" : "Add Person"}
        </h2>
        <p>
          Set the fixed monthly EMI for this person.
        </p>
      </div>

    </div>


    <label>
      Name

      <input
        id="bn"
        value="${esc(
          b.name
        )}"
        placeholder="Person name">
    </label>


    <label>
      Fixed Monthly EMI

      <input
        id="be"
        type="number"
        min="0"
        value="${
          N(b.scheduled_emi) || ""
        }"
        placeholder="₹ 0">
    </label>


    <div class="dh-info-box">

      <b>Extra payment</b>

      <span>
        Extra principal is entered separately during
        monthly payment entry and belongs entirely
        to this person.
      </span>

    </div>


    <button
      class="dh-btn primary full"
      onclick="savePerson('${id || ""}')">
      ✓ Save Person
    </button>

    ${
      id
        ? `
          <button
            class="dh-btn danger full"
            onclick="delPerson('${id}')">
            Delete Person
          </button>
        `
        : ""
    }

  `);
}


async function savePerson(id) {
  if (!isOwner()) return;

  const name =
    $("bn").value.trim() ||
    "Person";

  const emi =
    Math.max(
      0,
      N($("be").value)
    );

  const row = {
    loan_id: loan.id,
    name,
    scheduled_emi: emi,
    sort_order: id
      ? (
          bs.find(
            x => x.id === id
          )?.sort_order || 0
        )
      : bs.length
  };

  let q;

  if (id) {
    q =
      await db
        .from("borrowers")
        .update(row)
        .eq("id", id);
  } else {
    q =
      await db
        .from("borrowers")
        .insert(row);
  }

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Person saved",
    "success"
  );

  nav("people");
}


async function delPerson(id) {
  if (!isOwner()) return;

  if (
    !confirm(
      "Delete this person and their payment records?"
    )
  ) {
    return;
  }

  const q =
    await db
      .from("borrowers")
      .delete()
      .eq("id", id);

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Person deleted",
    "success"
  );
}


/* =========================================================
   REPORTS
   ========================================================= */

function reports() {
  if (!loan) {
    $("reports").innerHTML = `
      <div class="dh-empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const status =
    currentLoanStatus();

  const c =
    status.calc;

  const paid =
    N(loan.total_amount) -
    c.remaining;

  const paidPercent =
    loan.total_amount
      ? (paid / loan.total_amount) *
        100
      : 0;

  const projected =
    projectedTotalTenure();

  const fixed =
    totalFixedEMI();

  $("reports").innerHTML = `

    <div class="dh-page-head">

      <div>
        <small>ANALYSIS</small>
        <h2>Reports</h2>
      </div>

    </div>


    <!-- LOAN SUMMARY -->

    <div class="dh-card">

      <div class="dh-section-title">
        <div>
          <small>LOAN SUMMARY</small>
          <h3>
            ${esc(
              loan.name ||
              "Dream Home Loan"
            )}
          </h3>
        </div>
      </div>


      <div class="dh-report-grid">

        <div>
          <span>Original Loan</span>
          <b>${M(
            loan.total_amount
          )}</b>
        </div>

        <div>
          <span>Principal Paid</span>
          <b>${M(
            c.regularPrincipalPaid +
              c.extraPrincipalPaid
          )}</b>
        </div>

        <div>
          <span>Remaining Principal</span>
          <b>${M(
            c.remaining
          )}</b>
        </div>

        <div>
          <span>Interest Paid</span>
          <b>${M(
            c.interestPaid
          )}</b>
        </div>

        <div>
          <span>Extra Principal</span>
          <b>${M(
            c.extraPrincipalPaid
          )}</b>
        </div>

        <div>
          <span>Total Paid</span>
          <b>${M(
            c.totalPaid
          )}</b>
        </div>

        <div>
          <span>Loan Paid</span>
          <b>${paidPercent.toFixed(
            1
          )}%</b>
        </div>

        <div>
          <span>Projected Tenure</span>
          <b>
            ${
              projected === Infinity
                ? "Not possible"
                : `${projected} months`
            }
          </b>
        </div>

      </div>

    </div>


    <!-- PEOPLE TABLE -->

    <div class="dh-card">

      <div class="dh-section-title">

        <div>
          <small>CONTRIBUTION</small>
          <h3>People</h3>
        </div>

      </div>


      ${
        bs.length
          ? `
            <div class="dh-table-wrap">

              <table class="dh-table">

                <thead>
                  <tr>
                    <th>Person</th>
                    <th>EMI Paid</th>
                    <th>Extra</th>
                    <th>Total</th>
                    <th>Contribution</th>
                  </tr>
                </thead>

                <tbody>

                  ${bs
                    .map(b => {

                      let emi = 0;
                      let extra = 0;

                      ps
                        .filter(
                          x =>
                            x.borrower_id ===
                            b.id
                        )
                        .forEach(x => {
                          emi +=
                            N(x.emi_paid);

                          extra +=
                            N(
                              x.extra_principal
                            );
                        });

                      const total =
                        emi + extra;

                      const overall =
                        ps.reduce(
                          (s, x) =>
                            s +
                            N(x.emi_paid) +
                            N(
                              x.extra_principal
                            ),
                          0
                        );

                      const contribution =
                        overall
                          ? (total / overall) *
                            100
                          : 0;

                      return `
                        <tr>

                          <td>
                            <b>
                              ${esc(
                                b.name
                              )}
                            </b>
                          </td>

                          <td>
                            ${M(emi)}
                          </td>

                          <td>
                            ${M(extra)}
                          </td>

                          <td>
                            <b>
                              ${M(total)}
                            </b>
                          </td>

                          <td>
                            <b>
                              ${contribution.toFixed(
                                1
                              )}%
                            </b>
                          </td>

                        </tr>
                      `;
                    })
                    .join("")}

                </tbody>

              </table>

            </div>
          `
          : `
            <div class="dh-empty-small">
              No people available.
            </div>
          `
      }

    </div>


    <!-- LOAN PARAMETERS -->

    <div class="dh-card">

      <div class="dh-section-title">
        <div>
          <small>PARAMETERS</small>
          <h3>Loan Details</h3>
        </div>
      </div>


      <div class="dh-report-list">

        <div>
          <span>Interest Rate</span>
          <b>
            ${N(
              loan.annual_rate
            ).toFixed(2)}%
          </b>
        </div>

        <div>
          <span>Original Tenure</span>
          <b>
            ${N(
              loan.tenure_months
            )} months
          </b>
        </div>

        <div>
          <span>Fixed EMI</span>
          <b>${M(fixed)}</b>
        </div>

        <div>
          <span>Interest-only Period</span>
          <b>
            ${N(
              loan.interest_only_months
            )} months
          </b>
        </div>

        <div>
          <span>Payments Recorded</span>
          <b>
            ${status.lastMonth} month${
              status.lastMonth === 1
                ? ""
                : "s"
            }
          </b>
        </div>

      </div>

    </div>

  `;
}


/* =========================================================
   MORE
   ========================================================= */

function more() {
  $("more").innerHTML = `

    <div class="dh-page-head">

      <div>
        <small>SETTINGS</small>
        <h2>More</h2>
      </div>

    </div>


    <div class="dh-card">

      <div class="dh-account-row">

        <div class="dh-avatar big">
          ${user ? "✓" : "👤"}
        </div>

        <div>

          <small>ACCOUNT</small>

          <b>
            ${
              user
                ? esc(
                    user.email
                  )
                : "Public View"
            }
          </b>

          <span>
            ${
              user
                ? "Owner editing enabled"
                : "View only"
            }
          </span>

        </div>

      </div>

    </div>


    ${
      isOwner()
        ? `

          <div class="dh-card">

            <div class="dh-setting-row">

              <div>
                <b>Loan Settings</b>
                <span>
                  Amount, interest, tenure and EMI
                </span>
              </div>

              <button
                class="dh-icon-btn"
                onclick="loanEdit()">
                ⚙
              </button>

            </div>


            <div class="dh-setting-row">

              <div>
                <b>Payment History</b>
                <span>
                  View and edit recorded payments
                </span>
              </div>

              <button
                class="dh-icon-btn"
                onclick="nav('payments')">
                →
              </button>

            </div>

          </div>


          <div class="dh-card danger-card">

            <div class="dh-setting-row">

              <div>
                <b>Loan Reset</b>
                <span>
                  Delete this loan and all its data
                </span>
              </div>

              <button
                class="dh-btn danger small"
                onclick="resetLoan()">
                Reset
              </button>

            </div>

          </div>

        `
        : `
          <div class="dh-card">

            <div class="dh-info-box">

              <b>View Only</b>

              <span>
                Only the owner account can add,
                edit or reset loan information.
              </span>

            </div>

          </div>
        `
    }

  `;
}


/* =========================================================
   ACCOUNT POPUP
   ========================================================= */

function accountPopup() {
  if (user) {

    modal(`

      <div class="dh-modal-head">

        <div class="dh-modal-icon">
          ✓
        </div>

        <div>
          <h2>Owner Account</h2>
          <p>
            ${esc(user.email)}
          </p>
        </div>

      </div>


      <div class="dh-info-box success-box">

        <b>Owner access enabled</b>

        <span>
          You can add and edit payments, people and
          loan settings.
        </span>

      </div>


      <button
        class="dh-btn danger full"
        onclick="out()">
        Sign out
      </button>

    `);

  } else {

    auth();
  }
}


/* =========================================================
   AUTH
   ========================================================= */

function auth() {
  if (!db) {
    toast(
      "Supabase is not configured.",
      "error"
    );
    return;
  }

  modal(`

    <div class="dh-modal-head">

      <div class="dh-modal-icon">
        🔐
      </div>

      <div>
        <h2>Owner Sign In</h2>
        <p>
          Sign in to manage Dream Home.
        </p>
      </div>

    </div>


    <label>
      Email

      <input
        id="ae"
        type="email"
        autocomplete="email"
        placeholder="Owner email">
    </label>


    <label>
      Password

      <input
        id="ap"
        type="password"
        autocomplete="current-password"
        placeholder="Password">
    </label>


    <button
      class="dh-btn primary full"
      onclick="login()">
      Sign In
    </button>


    <button
      class="dh-btn secondary full"
      onclick="signup()">
      Create Owner Account
    </button>

  `);
}


async function login() {
  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password.",
      "error"
    );
    return;
  }

  const q =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Welcome back. Owner access enabled.",
    "success"
  );

  nav("dashboard");
}


async function signup() {
  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password.",
      "error"
    );
    return;
  }

  if (password.length < 6) {
    toast(
      "Password must contain at least 6 characters.",
      "error"
    );
    return;
  }

  const q =
    await db.auth.signUp({
      email,
      password
    });

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  if (
    q.data?.session
  ) {
    await load();

    toast(
      "Owner account created successfully.",
      "success"
    );
  } else {
    toast(
      "Account created. Check your email if confirmation is enabled.",
      "success"
    );
  }
}


async function out() {
  if (!db) return;

  const q =
    await db.auth.signOut();

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  user = null;

  await load();

  toast(
    "Signed out. Now viewing publicly.",
    "success"
  );

  nav("dashboard");
}


/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {
  if (!isOwner()) return;

  modal(`

    <div class="dh-modal-head">

      <div class="dh-modal-icon">
        ⚙
      </div>

      <div>
        <h2>Loan Settings</h2>
        <p>
          Update the main loan parameters.
        </p>
      </div>

    </div>


    <label>
      Loan Name

      <input
        id="ln"
        value="${esc(
          loan.name ||
          "Dream Home Loan"
        )}">
    </label>


    <div class="dh-edit-grid">

      <div>
        <label>Total Loan</label>

        <input
          id="la"
          type="number"
          value="${N(
            loan.total_amount
          )}">
      </div>


      <div>
        <label>Annual Interest %</label>

        <input
          id="lr"
          type="number"
          step="0.01"
          value="${N(
            loan.annual_rate
          )}">
      </div>


      <div>
        <label>Original Tenure</label>

        <input
          id="lt"
          type="number"
          min="1"
          value="${N(
            loan.tenure_months
          )}">
      </div>


      <div>
        <label>Start Date</label>

        <input
          id="ls"
          type="date"
          value="${
            loan.start_date || ""
          }">
      </div>


      <div>
        <label>Interest-only Months</label>

        <input
          id="li"
          type="number"
          min="0"
          value="${N(
            loan.interest_only_months
          )}">
      </div>


      <div>
        <label>EMI Mode</label>

        <select id="lm">

          <option
            value="auto"
            ${
              loan.emi_mode === "auto"
                ? "selected"
                : ""
            }>
            Auto
          </option>

          <option
            value="manual"
            ${
              loan.emi_mode === "manual"
                ? "selected"
                : ""
            }>
            Manual
          </option>

        </select>

      </div>

    </div>


    <label>
      Manual Fixed EMI
      <small>
        Used only when EMI Mode is Manual
      </small>

      <input
        id="le"
        type="number"
        min="0"
        value="${
          N(
            loan.manual_emi
          ) || ""
        }">
    </label>


    <div class="dh-info-box">

      <b>Automatic tenure</b>

      <span>
        After extra principal is paid, Dream Home
        recalculates the remaining tenure using the
        fixed EMI and current remaining principal.
      </span>

    </div>


    <button
      class="dh-btn primary full"
      onclick="saveLoan()">
      ✓ Save Loan Settings
    </button>

  `);
}


async function saveLoan() {
  if (!isOwner()) return;

  const v = {
    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount:
      Math.max(
        0,
        N($("la").value)
      ),

    annual_rate:
      Math.max(
        0,
        N($("lr").value)
      ),

    tenure_months:
      Math.max(
        1,
        Math.round(
          N($("lt").value)
        )
      ),

    start_date:
      $("ls").value,

    interest_only_months:
      Math.max(
        0,
        Math.round(
          N($("li").value)
        )
      ),

    emi_mode:
      $("lm").value,

    manual_emi:
      Math.max(
        0,
        N($("le").value)
      ),

    updated_at:
      new Date().toISOString()
  };

  const q =
    await db
      .from("loans")
      .update(v)
      .eq("id", loan.id)
      .select()
      .single();

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Loan settings updated.",
    "success"
  );

  nav("dashboard");
}


/* =========================================================
   LOAN RESET
   ========================================================= */

async function resetLoan() {
  if (!isOwner()) return;

  const first =
    confirm(
      "RESET DREAM HOME LOAN?\n\nThis will delete the loan, people and all payment records."
    );

  if (!first) return;

  const second =
    confirm(
      "This action cannot be undone. Continue?"
    );

  if (!second) return;

  /*
    Delete payments first.
  */

  let q =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id);

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  /*
    Delete borrowers.
  */

  q =
    await db
      .from("borrowers")
      .delete()
      .eq("loan_id", loan.id);

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  /*
    Delete loan.
  */

  q =
    await db
      .from("loans")
      .delete()
      .eq("id", loan.id);

  if (q.error) {
    toast(
      q.error.message,
      "error"
    );
    return;
  }

  loan = null;
  bs = [];
  ps = [];

  close();

  toast(
    "Loan reset successfully.",
    "success"
  );

  dashboard();
}


/* =========================================================
   MODAL
   ========================================================= */

function modal(html) {
  const mb = $("mb");

  if (!mb) return;

  mb.innerHTML = html;

  $("modal")
    .classList
    .add("open");
}


function close() {
  $("modal")
    ?.classList
    .remove("open");
}


$("x")?.addEventListener(
  "click",
  close
);


$("modal")?.addEventListener(
  "click",
  e => {
    if (
      e.target ===
      $("modal")
    ) {
      close();
    }
  }
);


/* =========================================================
   ATTRACTIVE UI STYLES
   ========================================================= */

(function addDreamHomeStyles() {

  const style =
    document.createElement("style");

  style.innerHTML = `

    :root {
      --dh-primary:#5b3df5;
      --dh-primary2:#8a5cf6;
      --dh-purple:#7c4dff;
      --dh-pink:#ec4899;
      --dh-blue:#2563eb;
      --dh-green:#0f9d78;
      --dh-orange:#f59e0b;
      --dh-red:#ef4444;
      --dh-bg:#f5f6fb;
      --dh-card:#ffffff;
      --dh-text:#171827;
      --dh-muted:#77798b;
      --dh-border:#ececf3;
      --dh-shadow:0 10px 30px rgba(38,32,80,.08);
    }

    body {
      background:
        linear-gradient(
          180deg,
          #f7f5ff 0%,
          #f8f9fc 40%,
          #ffffff 100%
        );
      color:var(--dh-text);
    }

    .screen {
      padding-bottom:100px;
    }

    .dh-hero {
      margin:16px;
      padding:22px;
      border-radius:26px;
      color:white;
      background:
        linear-gradient(
          135deg,
          var(--dh-primary),
          var(--dh-purple) 55%,
          var(--dh-pink)
        );
      box-shadow:
        0 18px 40px
        rgba(91,61,245,.25);
    }

    .dh-hero-top {
      display:flex;
      align-items:center;
      justify-content:space-between;
    }

    .dh-hero small,
    .dh-fixed-card small,
    .dh-section-title small,
    .dh-page-head small {
      font-size:10px;
      font-weight:800;
      letter-spacing:1.4px;
      opacity:.75;
    }

    .dh-big {
      font-size:34px;
      font-weight:900;
      margin-top:5px;
    }

    .dh-house {
      width:58px;
      height:58px;
      border-radius:20px;
      background:rgba(255,255,255,.16);
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:29px;
    }

    .dh-progress {
      height:9px;
      background:rgba(255,255,255,.22);
      border-radius:20px;
      overflow:hidden;
      margin-top:22px;
    }

    .dh-progress.light {
      background:#eeeeF7;
    }

    .dh-progress-fill {
      height:100%;
      border-radius:20px;
      background:
        linear-gradient(
          90deg,
          #ffffff,
          #fef08a
        );
      transition:width .5s ease;
    }

    .dh-progress.light
    .dh-progress-fill {
      background:
        linear-gradient(
          90deg,
          var(--dh-primary),
          var(--dh-pink)
        );
    }

    .dh-progress-text {
      display:flex;
      justify-content:space-between;
      margin-top:8px;
      font-size:11px;
      opacity:.9;
    }

    .dh-fixed-card {
      margin:16px;
      padding:18px 20px;
      border-radius:20px;
      background:white;
      box-shadow:var(--dh-shadow);
      border:1px solid var(--dh-border);
      display:flex;
      align-items:center;
      justify-content:space-between;
    }

    .dh-fixed-card strong {
      display:block;
      font-size:26px;
      margin-top:3px;
      color:var(--dh-primary);
    }

    .dh-fixed-label {
      padding:8px 13px;
      border-radius:30px;
      background:#f0edff;
      color:var(--dh-primary);
      font-size:11px;
      font-weight:800;
    }

    .dh-metrics {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin:16px;
    }

    .dh-metric {
      background:white;
      border:1px solid var(--dh-border);
      border-radius:18px;
      padding:15px;
      box-shadow:0 6px 20px rgba(40,35,80,.05);
    }

    .dh-metric span,
    .dh-person-stats span,
    .dh-report-grid span,
    .dh-report-list span {
      display:block;
      color:var(--dh-muted);
      font-size:11px;
      margin-bottom:5px;
    }

    .dh-metric strong {
      font-size:17px;
    }

    .dh-card {
      background:var(--dh-card);
      border:1px solid var(--dh-border);
      border-radius:22px;
      margin:16px;
      padding:18px;
      box-shadow:var(--dh-shadow);
    }

    .dh-card-title,
    .dh-section-title,
    .dh-page-head {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }

    .dh-card h3,
    .dh-section-title h3,
    .dh-page-head h2 {
      margin:3px 0 0;
    }

    .dh-round {
      width:48px;
      height:48px;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#f0edff;
      color:var(--dh-primary);
      font-size:12px;
      font-weight:900;
    }

    .dh-note {
      margin-top:12px;
      font-size:11px;
      color:var(--dh-muted);
      line-height:1.5;
    }

    .dh-actions {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin:16px;
    }

    .dh-btn {
      border:0;
      border-radius:15px;
      padding:13px 15px;
      font-weight:800;
      font-size:13px;
      cursor:pointer;
      transition:.2s;
    }

    .dh-btn:active {
      transform:scale(.97);
    }

    .dh-btn.primary {
      color:white;
      background:
        linear-gradient(
          135deg,
          var(--dh-primary),
          var(--dh-pink)
        );
      box-shadow:
        0 8px 20px
        rgba(91,61,245,.2);
    }

    .dh-btn.secondary {
      color:var(--dh-primary);
      background:#efedff;
    }

    .dh-btn.danger {
      color:white;
      background:var(--dh-red);
    }

    .dh-btn.small {
      padding:9px 12px;
      font-size:11px;
    }

    .dh-btn.full {
      width:100%;
      margin-top:10px;
    }

    .dh-page-head {
      margin:18px 16px;
    }

    .dh-page-head h2 {
      font-size:24px;
    }

    .dh-mini-info {
      display:grid;
      grid-template-columns:1.5fr 1fr 1fr;
      gap:10px;
    }

    .dh-mini-info div {
      min-width:0;
    }

    .dh-mini-info small {
      display:block;
      color:var(--dh-muted);
      font-size:9px;
      font-weight:800;
    }

    .dh-mini-info strong {
      display:block;
      margin-top:4px;
      font-size:12px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    .dh-payment-month {
      border-bottom:1px solid var(--dh-border);
      padding:4px 0 17px;
      margin-bottom:17px;
    }

    .dh-payment-month:last-child {
      border-bottom:0;
      margin-bottom:0;
    }

    .dh-payment-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
    }

    .dh-payment-header h3 {
      margin:3px 0 0;
    }

    .dh-payment-header small {
      color:var(--dh-muted);
      font-size:9px;
      font-weight:800;
      letter-spacing:1px;
    }

    .dh-icon-btn {
      border:0;
      width:38px;
      height:38px;
      border-radius:12px;
      background:#f0edff;
      color:var(--dh-primary);
      font-weight:900;
      cursor:pointer;
    }

    .dh-payment-summary {
      display:grid;
      grid-template-columns:1fr 1fr 1fr;
      gap:8px;
      margin-top:14px;
    }

    .dh-payment-summary div {
      padding:10px;
      border-radius:12px;
      background:#f8f8fc;
    }

    .dh-payment-summary span {
      display:block;
      font-size:9px;
      color:var(--dh-muted);
    }

    .dh-payment-summary b {
      display:block;
      margin-top:3px;
      font-size:11px;
    }

    .dh-payment-people {
      margin-top:10px;
    }

    .dh-person-line {
      display:flex;
      justify-content:space-between;
      gap:10px;
      padding:8px 0;
      font-size:11px;
    }

    .dh-person-line span:last-child {
      color:var(--dh-muted);
      text-align:right;
    }

    .dh-entry {
      margin-top:12px;
      padding:15px;
      border:1px solid var(--dh-border);
      border-radius:18px;
      background:#fafaff;
    }

    .dh-entry-head {
      display:flex;
      align-items:center;
      gap:10px;
      margin-bottom:12px;
    }

    .dh-entry-head b,
    .dh-entry-head small {
      display:block;
    }

    .dh-entry-head small {
      margin-top:3px;
      color:var(--dh-muted);
      font-size:10px;
    }

    .dh-avatar {
      width:38px;
      height:38px;
      border-radius:13px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:
        linear-gradient(
          135deg,
          var(--dh-primary),
          var(--dh-pink)
        );
      color:white;
      font-weight:900;
    }

    .dh-avatar.big {
      width:46px;
      height:46px;
      border-radius:15px;
    }

    label {
      display:block;
      font-size:11px;
      font-weight:800;
      color:#55576a;
      margin-top:12px;
    }

    input,
    select {
      width:100%;
      box-sizing:border-box;
      margin-top:6px;
      padding:12px 13px;
      border-radius:13px;
      border:1px solid #dedee9;
      background:white;
      font-size:14px;
      outline:none;
    }

    input:focus,
    select:focus {
      border-color:var(--dh-primary);
      box-shadow:
        0 0 0 3px
        rgba(91,61,245,.08);
    }

    input:disabled {
      background:#f1f1f6;
      color:#777;
    }

    .dh-field-note {
      display:block;
      color:var(--dh-muted);
      font-size:9px;
      margin-top:5px;
    }

    .dh-info-box {
      display:flex;
      flex-direction:column;
      gap:5px;
      margin-top:14px;
      padding:13px;
      border-radius:14px;
      background:#f2efff;
      color:#5a4ca4;
      font-size:11px;
      line-height:1.45;
    }

    .success-box {
      background:#eafaf4;
      color:#08795b;
    }

    .dh-edit-grid {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
    }

    .dh-edit-grid label {
      margin-top:0;
    }

    .dh-edit-actions {
      margin-top:12px;
      display:grid;
      gap:8px;
    }

    .dh-person-card {
      padding:16px 0;
      border-bottom:1px solid var(--dh-border);
    }

    .dh-person-card:last-child {
      border-bottom:0;
    }

    .dh-person-top {
      display:flex;
      align-items:center;
      gap:11px;
    }

    .dh-person-name {
      flex:1;
    }

    .dh-person-name b,
    .dh-person-name small {
      display:block;
    }

    .dh-person-name small {
      margin-top:4px;
      color:var(--dh-muted);
      font-size:10px;
    }

    .dh-person-stats {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:9px;
      margin-top:13px;
    }

    .dh-person-stats div {
      background:#f8f8fc;
      padding:10px;
      border-radius:12px;
    }

    .dh-person-stats b {
      font-size:12px;
    }

    .dh-report-grid {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin-top:15px;
    }

    .dh-report-grid div {
      padding:12px;
      border-radius:13px;
      background:#f8f8fc;
    }

    .dh-report-grid b {
      font-size:13px;
    }

    .dh-report-list {
      margin-top:12px;
    }

    .dh-report-list div {
      display:flex;
      justify-content:space-between;
      padding:11px 0;
      border-bottom:1px solid var(--dh-border);
    }

    .dh-report-list div:last-child {
      border-bottom:0;
    }

    .dh-report-list span {
      margin:0;
    }

    .dh-report-list b {
      font-size:12px;
    }

    .dh-table-wrap {
      overflow-x:auto;
      margin-top:12px;
    }

    .dh-table {
      width:100%;
      border-collapse:collapse;
      font-size:10px;
      min-width:500px;
    }

    .dh-table th {
      text-align:left;
      color:var(--dh-muted);
      font-size:9px;
      padding:9px;
      background:#f7f7fb;
    }

    .dh-table td {
      padding:10px 9px;
      border-bottom:1px solid var(--dh-border);
    }

    .dh-account-row {
      display:flex;
      align-items:center;
      gap:12px;
    }

    .dh-account-row b,
    .dh-account-row small,
    .dh-account-row span {
      display:block;
    }

    .dh-account-row small {
      color:var(--dh-muted);
      font-size:9px;
      font-weight:800;
    }

    .dh-account-row b {
      margin-top:3px;
      font-size:13px;
    }

    .dh-account-row span {
      margin-top:3px;
      color:var(--dh-green);
      font-size:10px;
    }

    .dh-setting-row {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      padding:13px 0;
      border-bottom:1px solid var(--dh-border);
    }

    .dh-setting-row:last-child {
      border-bottom:0;
    }

    .dh-setting-row b,
    .dh-setting-row span {
      display:block;
    }

    .dh-setting-row span {
      margin-top:4px;
      color:var(--dh-muted);
      font-size:10px;
    }

    .danger-card {
      border-color:#ffdada;
      background:#fffafa;
    }

    .dh-empty {
      margin:45px 20px;
      padding:35px 20px;
      text-align:center;
      background:white;
      border-radius:25px;
      box-shadow:var(--dh-shadow);
    }

    .dh-logo {
      font-size:45px;
      margin-bottom:10px;
    }

    .dh-empty h2 {
      margin:5px 0;
    }

    .dh-empty p {
      color:var(--dh-muted);
      font-size:12px;
    }

    .dh-empty-small {
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:7px;
      padding:35px 15px;
      text-align:center;
      color:var(--dh-muted);
      font-size:11px;
    }

    .dh-empty-small div {
      font-size:30px;
    }

    .modal {
      backdrop-filter:blur(8px);
      background:rgba(15,12,35,.42);
    }

    .sheet {
      border-radius:28px 28px 0 0 !important;
      padding:24px !important;
      max-height:90vh;
      overflow:auto;
    }

    .sheet #x {
      width:34px;
      height:34px;
      border:0;
      border-radius:50%;
      background:#f0f0f5;
      font-size:20px;
      cursor:pointer;
    }

    .dh-modal-head {
      display:flex;
      align-items:center;
      gap:12px;
      margin-bottom:18px;
    }

    .dh-modal-icon {
      width:46px;
      height:46px;
      border-radius:15px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:
        linear-gradient(
          135deg,
          var(--dh-primary),
          var(--dh-pink)
        );
      color:white;
      font-size:20px;
    }

    .dh-modal-head h2 {
      margin:0;
    }

    .dh-modal-head p {
      margin:4px 0 0;
      color:var(--dh-muted);
      font-size:10px;
    }

    .toast-message {
      position:fixed;
      left:16px;
      right:16px;
      bottom:90px;
      z-index:9999;
      padding:13px 15px;
      border-radius:16px;
      background:#20202c;
      color:white;
      box-shadow:
        0 15px 40px
        rgba(0,0,0,.2);
      display:flex;
      align-items:center;
      gap:10px;
      font-size:12px;
      font-weight:700;
    }

    .toast-message.success {
      background:#08795b;
    }

    .toast-message.error {
      background:#c62828;
    }

    .toast-icon {
      width:24px;
      height:24px;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      background:rgba(255,255,255,.18);
      font-weight:900;
    }

    @media(max-width:420px) {

      .dh-big {
        font-size:29px;
      }

      .dh-mini-info {
        grid-template-columns:1fr;
      }

      .dh-actions {
        grid-template-columns:1fr;
      }

      .dh-edit-grid {
        grid-template-columns:1fr;
      }

      .dh-payment-summary {
        grid-template-columns:1fr;
      }

    }

  `;

  document.head.appendChild(style);

})();


/* =========================================================
   SUPABASE AUTH STATE
   ========================================================= */

if (db) {

  db.auth.onAuthStateChange(
    () => {
      setTimeout(
        load,
        0
      );
    }
  );

  load();

} else {

  sync("bad");

  dashboard();
}


/* =========================================================
   SERVICE WORKER
   ========================================================= */

if (
  "serviceWorker" in navigator
) {
  navigator.serviceWorker
    .register("./sw.js")
    .catch(err =>
      console.log(
        "Service worker:",
        err
      )
    );
}


/* =========================================================
   INITIAL SCREEN
   ========================================================= */

nav("dashboard");
