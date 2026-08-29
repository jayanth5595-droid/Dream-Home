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
  }).format(Math.round(+n || 0));

const esc = x =>
  String(x ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function toast(t) {
  const el = $("toast");
  if (!el) return;
  el.textContent = t;
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 2500);
}

function sync(x) {
  const el = $("sync");
  if (!el) return;

  el.className =
    x === "ok"
      ? "ok"
      : x === "bad"
      ? "bad"
      : "";
}

function edit() {
  return !!user && !!loan && loan.created_by === user.id;
}

function rate() {
  return (+loan.annual_rate || 0) / 1200;
}

function emi(p, n = loan.tenure_months) {
  const r = rate();

  if (!p || !n) return 0;

  if (r) {
    return (
      p *
      r *
      Math.pow(1 + r, n) /
      (Math.pow(1 + r, n) - 1)
    );
  }

  return p / n;
}

function overall() {
  if (!loan) return 0;

  return loan.emi_mode === "manual"
    ? +loan.manual_emi || 0
    : emi(+loan.total_amount);
}

function pay(m, bid) {
  return (
    ps.find(
      x =>
        +x.month_no === +m &&
        x.borrower_id === bid
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}

/*
  Loan calculation.

  Each borrower's share is treated independently.

  During interest-only months:
  - EMI does NOT reduce principal.
  - Extra principal still reduces principal.

  After interest-only period:
  - Actual EMI first covers interest.
  - Amount above interest reduces principal.
  - Extra principal additionally reduces principal.
*/

function calc(b, n) {
  let bal = +b.share_amount || 0;
  let ip = 0;
  let pp = 0;
  let ex = 0;
  let un = 0;

  const r = rate();

  for (let m = 1; m <= n; m++) {
    const e = pay(m, b.id);

    const interest = bal * r;

    const paid = Math.max(0, +e.emi_paid || 0);
    const extra = Math.max(0, +e.extra_principal || 0);

    /*
      Interest paid from normal EMI
    */
    const interestPaid = Math.min(paid, interest);

    ip += interestPaid;

    /*
      Unpaid interest
    */
    un += Math.max(0, interest - paid);

    /*
      Normal EMI principal
    */
    let principal = 0;

    if (
      m > (+loan.interest_only_months || 0)
    ) {
      principal = Math.min(
        Math.max(0, paid - interest),
        bal
      );
    }

    /*
      Extra principal always reduces principal,
      including during interest-only period.
    */
    const extraPrincipal = Math.min(
      extra,
      Math.max(0, bal - principal)
    );

    bal = Math.max(
      0,
      bal - principal - extraPrincipal
    );

    pp += principal;
    ex += extraPrincipal;
  }

  return {
    bal,
    ip,
    pp,
    ex,
    un
  };
}


/* =========================
   NAVIGATION
========================= */

function nav(id) {
  document
    .querySelectorAll(".screen")
    .forEach(x => x.classList.remove("active"));

  const target = $(id);

  if (target) {
    target.classList.add("active");
  }

  document
    .querySelectorAll("nav button")
    .forEach(x =>
      x.classList.toggle(
        "active",
        x.dataset.s === id
      )
    );

  if ($("title")) {
    $("title").textContent =
      {
        dashboard: "Dashboard",
        payments: "Payments",
        people: "People",
        reports: "Reports",
        more: "More"
      }[id] || "Dream Home";
  }

  if (id === "dashboard") dashboard();
  if (id === "payments") payments();
  if (id === "people") people();
  if (id === "reports") reports();
  if (id === "more") more();
}

document
  .querySelectorAll("nav button")
  .forEach(x => {
    x.onclick = () => nav(x.dataset.s);
  });


/* =========================
   LOAD CLOUD DATA
========================= */

async function load() {
  if (!db) {
    sync("bad");
    dashboard();
    return;
  }

  sync("");

  try {
    const q = await db.auth.getUser();

    user = q.data?.user || null;

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
      toast(l.error.message);
      sync("bad");
      return;
    }

    loan = l.data || null;

    if (loan) {
      const [b, p] = await Promise.all([
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
        console.error(b.error);
        toast(b.error.message);
        sync("bad");
        return;
      }

      if (p.error) {
        console.error(p.error);
        toast(p.error.message);
        sync("bad");
        return;
      }

      bs = b.data || [];
      ps = p.data || [];
    } else {
      bs = [];
      ps = [];
    }

    sync("ok");

    dashboard();
  } catch (err) {
    console.error(err);
    toast(err.message || "Cloud connection error");
    sync("bad");
  }
}


/* =========================
   DASHBOARD
========================= */

function dashboard() {
  if (!loan) {
    $("dashboard").innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Public view ready</strong>
        <div>
          ${
            user
              ? "Create your cloud loan to get started."
              : "Owner sign-in is required to create the cloud loan."
          }
        </div>
      </div>

      <div class="card">
        <h2>Cloud setup</h2>

        <p class="muted">
          No loan has been created yet.
        </p>

        ${
          user
            ? `
              <button
                class="btn primary"
                onclick="loanEdit()">
                🏠 Create loan
              </button>
            `
            : `
              <button
                class="btn primary"
                onclick="auth()">
                🔐 Owner sign in
              </button>
            `
        }
      </div>
    `;

    return;
  }

  const a = bs.map(b => ({
    b,
    ...calc(b, loan.tenure_months)
  }));

  const remain = a.reduce(
    (x, y) => x + y.bal,
    0
  );

  const principal = a.reduce(
    (x, y) => x + y.pp + y.ex,
    0
  );

  const extra = a.reduce(
    (x, y) => x + y.ex,
    0
  );

  const interest = a.reduce(
    (x, y) => x + y.ip,
    0
  );

  $("dashboard").innerHTML = `
    <div class="hero">
      <small>REMAINING PRINCIPAL</small>

      <strong>${M(remain)}</strong>

      <div>
        ${M(loan.total_amount)}
        original ·
        ${loan.annual_rate}%
        ·
        ${loan.tenure_months} months
      </div>
    </div>

    <div class="metrics">

      <div class="metric">
        <small>Principal paid</small>
        <strong>${M(principal)}</strong>
      </div>

      <div class="metric">
        <small>Extra paid</small>
        <strong>${M(extra)}</strong>
      </div>

      <div class="metric">
        <small>Interest paid</small>
        <strong>${M(interest)}</strong>
      </div>

      <div class="metric">
        <small>Overall EMI</small>
        <strong>${M(overall())}</strong>
      </div>

    </div>

    <div class="card">

      <div class="pt">
        <h2>Borrowers</h2>

        <span class="pill">
          ${edit() ? "OWNER" : "VIEW ONLY"}
        </span>
      </div>

      ${
        a.length
          ? a
              .map(x => {
                const pct =
                  x.b.share_amount
                    ? ((x.b.share_amount - x.bal) /
                        x.b.share_amount) *
                      100
                    : 0;

                return `
                  <div class="person">

                    <div class="pt">
                      <b>${esc(x.b.name)}</b>

                      <span class="pill">
                        ${M(x.b.scheduled_emi)}/mo
                      </span>
                    </div>

                    <div class="muted">
                      Remaining principal
                    </div>

                    <div class="bal">
                      ${M(x.bal)}
                    </div>

                    <div class="bar">
                      <i
                        style="width:${Math.max(
                          0,
                          Math.min(100, pct)
                        )}%">
                      </i>
                    </div>

                    <div class="muted">
                      ${M(x.ex)} extra ·
                      ${M(x.ip)} interest
                      ${
                        x.un
                          ? ` · ⚠️ ${M(
                              x.un
                            )} unpaid interest`
                          : ""
                      }
                    </div>

                  </div>
                `;
              })
              .join("")
          : `
            <div class="empty">
              No borrowers added yet.
            </div>
          `
      }

    </div>

    <div class="actions">

      ${
        edit()
          ? `
            <button
              class="btn primary"
              onclick="payment()">
              ＋ Add payment
            </button>

            <button
              class="btn soft"
              onclick="loanEdit()">
              ⚙️ Loan settings
            </button>
          `
          : `
            <button
              class="btn soft"
              onclick="auth()">
              🔐 Owner sign in
            </button>

            <button
              class="btn soft"
              onclick="history()">
              📜 History
            </button>
          `
      }

    </div>
  `;
}


/* =========================
   PEOPLE
========================= */

function people() {
  $("people").innerHTML = `
    <div class="card">

      <div class="pt">

        <h2>Borrowers</h2>

        ${
          edit()
            ? `
              <button
                class="btn soft"
                onclick="person()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        bs.length
          ? bs
              .map(
                b => `
                <div class="row">

                  <div>
                    <b>${esc(b.name)}</b>

                    <div class="muted">
                      Share ${M(b.share_amount)}
                      ·
                      EMI ${M(b.scheduled_emi)}
                    </div>
                  </div>

                  ${
                    edit()
                      ? `
                        <button
                          class="btn soft"
                          onclick="person('${b.id}')">
                          Edit
                        </button>
                      `
                      : ""
                  }

                </div>
              `
              )
              .join("")
          : `
            <div class="empty">
              No borrowers added.
            </div>
          `
      }

    </div>
  `;
}


/* =========================
   PAYMENTS
========================= */

function payments() {
  const months = [
    ...new Set(
      ps.map(x => +x.month_no)
    )
  ].sort((a, b) => b - a);

  $("payments").innerHTML = `
    <div class="card">

      <div class="pt">

        <div>
          <h2>Monthly payments</h2>

          <div class="muted">
            ${months.length} month(s) saved
          </div>
        </div>

        ${
          edit()
            ? `
              <button
                class="btn primary"
                onclick="payment()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        months.length
          ? months
              .map(m => {
                const q = ps.filter(
                  x => +x.month_no === +m
                );

                const emiTotal =
                  q.reduce(
                    (a, x) =>
                      a +
                      (+x.emi_paid || 0),
                    0
                  );

                const extraTotal =
                  q.reduce(
                    (a, x) =>
                      a +
                      (+x.extra_principal ||
                        0),
                    0
                  );

                return `
                  <div class="row">

                    <div>
                      <b>Month ${m}</b>

                      <div class="muted">
                        EMI ${M(emiTotal)}
                        ·
                        Extra ${M(extraTotal)}
                      </div>
                    </div>

                    <span class="pill">
                      Saved
                    </span>

                  </div>
                `;
              })
              .join("")
          : `
            <div class="empty">
              No payments recorded.
            </div>
          `
      }

    </div>
  `;
}


/* =========================
   REPORTS
========================= */

function reports() {
  if (!loan) {
    $("reports").innerHTML = `
      <div class="card">
        <h2>Loan report</h2>
        <div class="empty">
          No loan has been created yet.
        </div>
      </div>
    `;
    return;
  }

  const remaining = bs.reduce(
    (a, b) =>
      a +
      calc(
        b,
        loan.tenure_months
      ).bal,
    0
  );

  $("reports").innerHTML = `
    <div class="card">

      <h2>Loan report</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${M(loan.total_amount)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${M(remaining)}</b>
      </div>

      <div class="row">
        <span>Interest rate</span>
        <b>${loan.annual_rate}%</b>
      </div>

      <div class="row">
        <span>Tenure</span>
        <b>${loan.tenure_months} months</b>
      </div>

      <div class="row">
        <span>Interest-only period</span>
        <b>${loan.interest_only_months || 0} months</b>
      </div>

      <div class="row">
        <span>Overall EMI</span>
        <b>${M(overall())}</b>
      </div>

    </div>
  `;
}


/* =========================
   MORE
========================= */

function more() {
  $("more").innerHTML = `
    <div class="card">

      <h2>Account</h2>

      <div class="muted">
        ${
          user
            ? "Signed in as " +
              esc(user.email) +
              " — owner editing enabled."
            : "Public view mode — owner only can edit."
        }
      </div>

      <br>

      <button
        class="btn ${
          user ? "soft" : "primary"
        }"
        onclick="${
          user ? "out()" : "auth()"
        }">

        ${
          user
            ? "Sign out"
            : "🔐 Owner sign in"
        }

      </button>

    </div>

    <div class="card">

      <h2>Manage</h2>

      ${
        edit()
          ? `
            <div class="row">

              <b>Loan settings</b>

              <button
                class="btn soft"
                onclick="loanEdit()">
                Open
              </button>

            </div>

            <div class="row">

              <b>Borrowers</b>

              <button
                class="btn soft"
                onclick="person()">
                Open
              </button>

            </div>
          `
          : ""
      }

      <div class="row">

        <b>Payment history</b>

        <button
          class="btn soft"
          onclick="history()">
          Open
        </button>

      </div>

    </div>
  `;
}


/* =========================
   MODAL
========================= */

function modal(h) {
  $("mb").innerHTML = h;
  $("modal").classList.add("open");
}

function close() {
  $("modal").classList.remove("open");
}

$("x").onclick = close;

$("modal").onclick = e => {
  if (e.target === $("modal")) {
    close();
  }
};


/* =========================
   ACCOUNT BUTTON
========================= */

/*
  THIS WAS MISSING IN THE OLD VERSION.
*/

if ($("account")) {
  $("account").onclick = () => {
    auth();
  };
}


/* =========================
   AUTHENTICATION
========================= */

function auth() {
  if (!db) {
    toast(
      "Supabase is not configured."
    );
    return;
  }

  modal(`
    <h2>Owner sign in</h2>

    <p class="muted">
      Only the owner account can edit
      cloud data.
    </p>

    <label>
      Email
      <input
        id="ae"
        type="email"
        autocomplete="email">
    </label>

    <label>
      Password
      <input
        id="ap"
        type="password"
        autocomplete="current-password">
    </label>

    <button
      class="btn primary"
      onclick="login()">
      Sign in
    </button>

    <button
      class="btn soft"
      onclick="signup()">
      Create owner account
    </button>
  `);
}

async function login() {
  if (!db) {
    toast("Supabase is not configured.");
    return;
  }

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Enter email and password."
    );
    return;
  }

  const q =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message);
    return;
  }

  user = q.data.user;

  close();

  await load();

  toast("Signed in successfully.");
}

async function signup() {
  if (!db) {
    toast("Supabase is not configured.");
    return;
  }

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Enter email and password."
    );
    return;
  }

  if (password.length < 6) {
    toast(
      "Password must be at least 6 characters."
    );
    return;
  }

  const q =
    await db.auth.signUp({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message);
    return;
  }

  if (q.data.user) {
    user = q.data.user;

    close();

    /*
      If email confirmation is enabled,
      Supabase may not give us an active
      session until the email is confirmed.
    */
    if (!q.data.session) {
      toast(
        "Account created. Check your email and confirm the account."
      );
    } else {
      toast(
        "Owner account created."
      );
    }

    await load();
  }
}

async function out() {
  if (!db) return;

  await db.auth.signOut();

  user = null;

  await load();

  toast("Signed out.");
}


/* =========================
   LOAN SETTINGS / CREATE LOAN
========================= */

function loanEdit() {
  if (!user) {
    auth();
    return;
  }

  /*
    If no loan exists, this form creates one.
    If a loan exists, it edits the existing loan.
  */

  const creating = !loan;

  const current = loan || {
    name: "Dream Home Loan",
    total_amount: 0,
    annual_rate: 8.9,
    tenure_months: 240,
    start_date:
      new Date()
        .toISOString()
        .slice(0, 10),
    interest_only_months: 0,
    emi_mode: "manual",
    manual_emi: 0
  };

  modal(`
    <h2>
      ${
        creating
          ? "Create loan"
          : "Loan settings"
      }
    </h2>

    <div class="grid">

      <label class="full">
        Loan name
        <input
          id="ln"
          value="${esc(current.name)}">
      </label>

      <label>
        Total loan amount
        <input
          id="la"
          type="number"
          min="0"
          step="1"
          value="${current.total_amount}">
      </label>

      <label>
        Annual interest %
        <input
          id="lr"
          type="number"
          min="0"
          step="0.01"
          value="${current.annual_rate}">
      </label>

      <label>
        Tenure months
        <input
          id="lt"
          type="number"
          min="1"
          value="${current.tenure_months}">
      </label>

      <label>
        Start date
        <input
          id="ls"
          type="date"
          value="${current.start_date || ""}">
      </label>

      <label>
        Interest-only months
        <input
          id="li"
          type="number"
          min="0"
          value="${current.interest_only_months || 0}">
      </label>

      <label>
        EMI mode

        <select id="lm">

          <option
            value="auto"
            ${
              current.emi_mode === "auto"
                ? "selected"
                : ""
            }>
            Auto
          </option>

          <option
            value="manual"
            ${
              current.emi_mode === "manual"
                ? "selected"
                : ""
            }>
            Manual
          </option>

        </select>
      </label>

      <label>
        Manual EMI
        <input
          id="le"
          type="number"
          min="0"
          value="${current.manual_emi || ""}">
      </label>

    </div>

    <p class="muted">
      During the interest-only period,
      regular EMI does not reduce principal.
      Extra principal always reduces the
      corresponding borrower's principal.
    </p>

    <button
      class="btn primary"
      onclick="saveLoan()">

      ${
        creating
          ? "Create loan"
          : "Save changes"
      }

    </button>
  `);
}

async function saveLoan() {
  if (!db || !user) {
    auth();
    return;
  }

  const total =
    +$("la").value || 0;

  const annualRate =
    +$("lr").value || 0;

  const tenure =
    +$("lt").value || 0;

  const interestOnly =
    +$("li").value || 0;

  if (total <= 0) {
    toast(
      "Enter a valid loan amount."
    );
    return;
  }

  if (annualRate < 0) {
    toast(
      "Enter a valid interest rate."
    );
    return;
  }

  if (tenure <= 0) {
    toast(
      "Enter a valid tenure."
    );
    return;
  }

  if (interestOnly > tenure) {
    toast(
      "Interest-only period cannot exceed tenure."
    );
    return;
  }

  const v = {
    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount: total,

    annual_rate: annualRate,

    tenure_months: tenure,

    start_date: $("ls").value || null,

    interest_only_months:
      interestOnly,

    emi_mode:
      $("lm").value,

    manual_emi:
      +$("le").value || 0,

    updated_at:
      new Date().toISOString()
  };

  let q;

  /*
    CREATE FIRST LOAN
  */

  if (!loan) {
    q = await db
      .from("loans")
      .insert({
        ...v,
        created_by: user.id
      })
      .select()
      .single();
  }

  /*
    UPDATE EXISTING LOAN
  */

  else {
    q = await db
      .from("loans")
      .update(v)
      .eq("id", loan.id)
      .eq("created_by", user.id)
      .select()
      .single();
  }

  if (q.error) {
    console.error(q.error);
    toast(q.error.message);
    return;
  }

  loan = q.data;

  close();

  await load();

  toast(
    !loan
      ? "Loan created."
      : "Loan saved."
  );
}


/* =========================
   BORROWER
========================= */

function person(id) {
  if (!edit()) {
    auth();
    return;
  }

  const b =
    bs.find(x => x.id === id) || {
      name: "New Person",
      share_amount: 0,
      scheduled_emi: 0
    };

  modal(`
    <h2>
      ${id ? "Edit" : "Add"} borrower
    </h2>

    <label>
      Name
      <input
        id="bn"
        value="${esc(b.name)}">
    </label>

    <div class="grid">

      <label>
        Share amount
        <input
          id="bsx"
          type="number"
          min="0"
          value="${b.share_amount}">
      </label>

      <label>
        Monthly EMI
        <input
          id="be"
          type="number"
          min="0"
          value="${b.scheduled_emi}">
      </label>

    </div>

    <button
      class="btn primary"
      onclick="savePerson('${id || ""}')">

      Save borrower

    </button>

    ${
      id
        ? `
          <button
            class="btn danger"
            onclick="delPerson('${id}')">
            Delete
          </button>
        `
        : ""
    }
  `);
}

async function savePerson(id) {
  if (!edit()) {
    auth();
    return;
  }

  const share =
    +$("bsx").value || 0;

  const scheduled =
    +$("be").value || 0;

  if (share < 0) {
    toast("Invalid share amount.");
    return;
  }

  const v = {
    loan_id: loan.id,

    name:
      $("bn").value.trim() ||
      "Person",

    share_amount: share,

    scheduled_emi: scheduled,

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
    q = await db
      .from("borrowers")
      .update(v)
      .eq("id", id)
      .select()
      .single();
  } else {
    q = await db
      .from("borrowers")
      .insert(v)
      .select()
      .single();
  }

  if (q.error) {
    console.error(q.error);
    toast(q.error.message);
    return;
  }

  close();

  await load();

  toast("Borrower saved.");
}

async function delPerson(id) {
  if (!edit()) {
    auth();
    return;
  }

  if (
    !confirm(
      "Delete borrower and their payments?"
    )
  ) {
    return;
  }

  const q = await db
    .from("borrowers")
    .delete()
    .eq("id", id);

  if (q.error) {
    toast(q.error.message);
    return;
  }

  close();

  await load();

  toast("Borrower deleted.");
}


/* =========================
   MONTHLY PAYMENT
========================= */

function payment() {
  if (!edit()) {
    auth();
    return;
  }

  if (!bs.length) {
    toast(
      "Add borrowers before entering payments."
    );
    return;
  }

  const defaultMonth =
    ps.length
      ? Math.max(
          ...ps.map(
            x => +x.month_no
          )
        ) + 1
      : 1;

  let m = +prompt(
    "Month number (1-" +
      loan.tenure_months +
      ")",
    defaultMonth
  );

  if (
    !m ||
    m < 1 ||
    m > loan.tenure_months
  ) {
    return;
  }

  modal(`
    <h2>
      Month ${m} payment
    </h2>

    <p class="muted">
      Enter the actual EMI paid and any
      extra principal paid for each borrower.
    </p>

    <div id="prs"></div>

    <button
      class="btn primary"
      onclick="savePayment(${m})">

      Save to cloud

    </button>
  `);

  $("prs").innerHTML = bs
    .map(b => {
      const e = pay(m, b.id);

      const before =
        calc(b, m - 1);

      const interest =
        before.bal * rate();

      return `
        <div class="pay">

          <b>
            ${esc(b.name)}
          </b>

          <div class="grid">

            <label>
              Scheduled EMI

              <input
                disabled
                value="${Math.round(
                  b.scheduled_emi
                )}">
            </label>

            <label>
              Actual EMI

              <input
                id="e${b.id}"
                type="number"
                min="0"
                value="${
                  e.emi_paid || ""
                }">
            </label>

            <label>
              Extra principal

              <input
                id="x${b.id}"
                type="number"
                min="0"
                value="${
                  e.extra_principal || ""
                }">
            </label>

            <label>
              Opening principal

              <input
                disabled
                value="${M(before.bal)}">
            </label>

          </div>

          <div class="calc">

            Interest due:
            <b>${M(interest)}</b>

            <br>

            ${
              m <=
              (+loan.interest_only_months ||
                0)
                ? `
                  Interest-only month:
                  regular EMI will not reduce
                  principal.
                `
                : `
                  EMI above interest can reduce
                  principal.
                `
            }

          </div>

        </div>
      `;
    })
    .join("");
}

async function savePayment(m) {
  if (!edit()) {
    auth();
    return;
  }

  for (const b of bs) {
    const v = {
      loan_id: loan.id,

      borrower_id: b.id,

      month_no: m,

      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid:
        +$(
          "e" + b.id
        ).value || 0,

      extra_principal:
        +$(
          "x" + b.id
        ).value || 0
    };

    const q =
      await db
        .from("monthly_payments")
        .upsert(
          v,
          {
            onConflict:
              "loan_id,borrower_id,month_no"
          }
        );

    if (q.error) {
      console.error(q.error);
      toast(q.error.message);
      return;
    }
  }

  close();

  await load();

  toast(
    "Payment saved to cloud."
  );
}


/* =========================
   HISTORY
========================= */

function history() {
  if (!loan) {
    toast(
      "No loan has been created yet."
    );
    return;
  }

  let rows = "";

  for (
    let m = 1;
    m <= loan.tenure_months;
    m++
  ) {
    for (const b of bs) {
      const e = pay(m, b.id);

      if (
        !e.emi_paid &&
        !e.extra_principal
      ) {
        continue;
      }

      rows += `
        <tr>

          <td>${m}</td>

          <td>
            ${esc(b.name)}
          </td>

          <td>
            ${M(e.emi_paid)}
          </td>

          <td>
            ${M(e.extra_principal)}
          </td>

          <td>
            ${M(
              calc(
                b,
                m
              ).bal
            )}
          </td>

        </tr>
      `;
    }
  }

  modal(`
    <h2>
      Payment history
    </h2>

    ${
      rows
        ? `
          <div class="table">

            <table>

              <tr>
                <th>Month</th>
                <th>Person</th>
                <th>EMI</th>
                <th>Extra</th>
                <th>Balance</th>
              </tr>

              ${rows}

            </table>

          </div>
        `
        : `
          <div class="empty">
            No payments saved.
          </div>
        `
    }
  `);
}


/* =========================
   SUPABASE AUTH STATE
========================= */

if (db) {
  db.auth.onAuthStateChange(
    () => {
      setTimeout(
        () => load(),
        0
      );
    }
  );

  load();
} else {
  sync("bad");
  dashboard();
}


/* =========================
   SERVICE WORKER
========================= */

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


/* =========================
   INITIAL SCREEN
========================= */

nav("dashboard");
