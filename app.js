/* ============================================================
   DREAM HOME v3
   Full app.js
   Public viewing + Owner-only editing + Supabase cloud sync
   ============================================================ */

const CFG = window.DREAM_HOME || {};

const ready =
    CFG.url &&
    !CFG.url.includes("PASTE_") &&
    CFG.key &&
    !CFG.key.includes("PASTE_");

const db = ready
    ? supabase.createClient(CFG.url, CFG.key)
    : null;

/* -----------------------------
   GLOBAL STATE
----------------------------- */

let user = null;
let loan = null;
let borrowers = [];
let paymentsData = [];

const $ = id => document.getElementById(id);

const money = n =>
    new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(Math.round(Number(n) || 0));

const esc = x =>
    String(x ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

/* -----------------------------
   TOAST
----------------------------- */

function toast(message, type = "normal") {

    const t = $("toast");

    if (!t) return;

    t.className = "toast-message " + type;

    const icon =
        type === "success" ? "✓" :
        type === "error" ? "!" :
        "i";

    t.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span>${esc(message)}</span>
    `;

    t.style.display = "flex";

    clearTimeout(window.__toastTimer);

    window.__toastTimer = setTimeout(() => {
        t.style.display = "none";
    }, 2600);
}

/* -----------------------------
   SYNC INDICATOR
----------------------------- */

function syncStatus(state) {

    const s = $("sync");

    if (!s) return;

    s.className = "";

    if (state === "ok") {
        s.classList.add("ok");
        s.title = "Cloud connected";
    }

    if (state === "bad") {
        s.classList.add("bad");
        s.title = "Cloud connection problem";
    }
}

/* -----------------------------
   OWNER CHECK
----------------------------- */

function isOwner() {

    return !!(
        user &&
        loan &&
        loan.created_by &&
        loan.created_by === user.id
    );
}

/* -----------------------------
   DATE HELPERS
----------------------------- */

function parseDate(value) {

    if (!value) return null;

    const d = new Date(value + "T00:00:00");

    return isNaN(d.getTime()) ? null : d;
}

function monthKey(date) {

    return (
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0")
    );
}

function monthLabel(date) {

    return date.toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric"
    });
}

/*
   If loan is taken in August,
   first EMI month = September.
*/
function getFirstEMIMonth() {

    const d = parseDate(loan?.start_date);

    if (!d) return new Date();

    return new Date(
        d.getFullYear(),
        d.getMonth() + 1,
        1
    );
}

function getEMIMonths() {

    if (!loan) return [];

    const first = getFirstEMIMonth();

    const result = [];

    const total = Number(loan.tenure_months) || 0;

    for (let i = 0; i < total; i++) {

        const d = new Date(
            first.getFullYear(),
            first.getMonth() + i,
            1
        );

        result.push({
            no: i + 1,
            key: monthKey(d),
            label: monthLabel(d),
            date: d
        });
    }

    return result;
}

/* -----------------------------
   LOAN CALCULATIONS
----------------------------- */

function monthlyRate() {

    return (Number(loan?.annual_rate) || 0) / 1200;
}

/*
   Minimum EMI is ALWAYS calculated
   from loan amount + interest + tenure.
*/
function minimumEMI() {

    if (!loan) return 0;

    const principal = Number(loan.total_amount) || 0;

    const months = Number(loan.tenure_months) || 0;

    const r = monthlyRate();

    if (!principal || !months) return 0;

    if (!r) {
        return principal / months;
    }

    return (
        principal *
        r *
        Math.pow(1 + r, months) /
        (Math.pow(1 + r, months) - 1)
    );
}

/*
   Fixed EMI = total of all people's
   fixed EMI amounts.
*/
function fixedEMI() {

    return borrowers.reduce(
        (sum, b) =>
            sum + (Number(b.scheduled_emi) || 0),
        0
    );
}

/*
   Automatic extra amount created when
   Fixed EMI exceeds Minimum EMI.
*/
function automaticExtraEMI() {

    return Math.max(
        0,
        fixedEMI() - minimumEMI()
    );
}

/* -----------------------------
   PAYMENT LOOKUP
----------------------------- */

function getPayment(monthNo, borrowerId) {

    return (
        paymentsData.find(
            p =>
                Number(p.month_no) === Number(monthNo) &&
                p.borrower_id === borrowerId
        ) || {
            emi_paid: 0,
            extra_principal: 0
        }
    );
}

/* -----------------------------
   TOTAL PAYMENT BY MONTH
----------------------------- */

function getMonthPayments(monthNo) {

    return paymentsData.filter(
        p => Number(p.month_no) === Number(monthNo)
    );
}

/* -----------------------------
   COMPLETE LOAN CALCULATION
----------------------------- */

/*
   IMPORTANT:

   Interest is calculated on FULL outstanding
   loan principal.

   Individual share/principal is NOT used.

   Fixed EMI is the actual agreed payment.

   If Fixed EMI > Minimum EMI:
       excess = automatic extra principal

   Automatic excess is divided equally among
   all borrowers.

   Individual extra principal remains that
   person's own contribution.
*/

function calculateLoan(untilMonth = null) {

    if (!loan) {

        return {
            principal: 0,
            interestPaid: 0,
            principalPaid: 0,
            extraPaid: 0,
            totalPaid: 0,
            unpaidInterest: 0,
            monthsCompleted: 0
        };
    }

    const totalPrincipal =
        Number(loan.total_amount) || 0;

    let balance = totalPrincipal;

    let interestPaid = 0;
    let principalPaid = 0;
    let extraPaid = 0;
    let totalPaid = 0;
    let unpaidInterest = 0;

    const months =
        getEMIMonths();

    const maxMonth =
        untilMonth == null
            ? months.length
            : Math.min(untilMonth, months.length);

    const interestOnly =
        Number(loan.interest_only_months) || 0;

    const r = monthlyRate();

    for (let i = 1; i <= maxMonth; i++) {

        if (balance <= 0) break;

        const monthRows =
            getMonthPayments(i);

        const actualEMI =
            monthRows.reduce(
                (sum, p) =>
                    sum + (Number(p.emi_paid) || 0),
                0
            );

        const personalExtra =
            monthRows.reduce(
                (sum, p) =>
                    sum +
                    (Number(p.extra_principal) || 0),
                0
            );

        const interestDue =
            balance * r;

        /*
           During interest-only period:
           EMI goes to interest only.
        */

        let interestPayment =
            Math.min(
                actualEMI,
                interestDue
            );

        /*
           After interest-only period:
           payment above interest reduces principal.
        */

        let principalFromEMI = 0;

        if (i > interestOnly) {

            principalFromEMI =
                Math.min(
                    Math.max(
                        0,
                        actualEMI - interestDue
                    ),
                    balance
                );
        }

        /*
           Any separately entered extra
           payment goes directly to principal.
        */

        let extra =
            Math.min(
                personalExtra,
                Math.max(
                    0,
                    balance - principalFromEMI
                )
            );

        /*
           IMPORTANT:
           Fixed EMI above Minimum EMI creates
           automatic extra principal.

           Do NOT double count if the entered
           EMI itself already includes that amount.

           Therefore automatic extra is calculated
           from the fixed EMI and minimum EMI,
           but only when actual EMI reaches
           the fixed EMI level.
        */

        let autoExtra = 0;

        if (
            i > interestOnly &&
            actualEMI >= fixedEMI() &&
            fixedEMI() > minimumEMI()
        ) {

            autoExtra =
                Math.min(
                    automaticExtraEMI(),
                    Math.max(
                        0,
                        balance -
                        principalFromEMI
                    )
                );
        }

        /*
           If actual EMI already created principal
           reduction because it is above interest,
           automatic extra must not be counted twice.

           The intended model is:
           Minimum EMI portion services normal loan.
           Fixed EMI excess is extra principal.
        */

        if (i > interestOnly) {

            const normalPrincipal =
                Math.min(
                    Math.max(
                        0,
                        minimumEMI() - interestDue
                    ),
                    balance
                );

            const fixedExcess =
                Math.max(
                    0,
                    fixedEMI() - minimumEMI()
                );

            if (
                actualEMI >= fixedEMI()
            ) {

                principalFromEMI =
                    Math.min(
                        normalPrincipal,
                        balance
                    );

                autoExtra =
                    Math.min(
                        fixedExcess,
                        Math.max(
                            0,
                            balance -
                            principalFromEMI
                        )
                    );
            }
        }

        /*
           During interest-only period,
           fixed EMI can still cover interest,
           but does not reduce principal.
        */

        const totalPrincipalReduction =
            Math.min(
                balance,
                principalFromEMI +
                autoExtra +
                extra
            );

        interestPaid += interestPayment;

        principalPaid +=
            Math.max(
                0,
                totalPrincipalReduction -
                extra
            );

        extraPaid +=
            extra +
            autoExtra;

        totalPaid +=
            actualEMI +
            personalExtra;

        unpaidInterest +=
            Math.max(
                0,
                interestDue - interestPayment
            );

        balance -=
            totalPrincipalReduction;
    }

    return {
        principal: Math.max(0, balance),
        interestPaid,
        principalPaid,
        extraPaid,
        totalPaid,
        unpaidInterest,
        monthsCompleted: maxMonth
    };
}

/* -----------------------------
   PROJECTED TENURE
----------------------------- */

function projectedTenure() {

    if (!loan) return 0;

    const current =
        calculateLoan();

    let balance =
        current.principal;

    if (balance <= 0) return 0;

    const emi =
        minimumEMI();

    const r =
        monthlyRate();

    if (!emi) return 0;

    let months = 0;

    while (
        balance > 0 &&
        months < 1000
    ) {

        months++;

        const interest =
            balance * r;

        if (emi <= interest && r > 0) {

            return 999;
        }

        const principal =
            r
                ? Math.min(
                    balance,
                    emi - interest
                )
                : Math.min(
                    balance,
                    emi
                );

        balance -= principal;
    }

    return months;
}

/* -----------------------------
   PAYMENT PROGRESS
----------------------------- */

function paidEMICount() {

    if (!loan) return 0;

    return new Set(
        paymentsData
            .filter(p =>
                Number(p.emi_paid) > 0 ||
                Number(p.extra_principal) > 0
            )
            .map(p => Number(p.month_no))
    ).size;
}

/* -----------------------------
   NAVIGATION
----------------------------- */

function nav(id) {

    document
        .querySelectorAll(".screen")
        .forEach(x =>
            x.classList.remove("active")
        );

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

/* -----------------------------
   LOAD CLOUD DATA
----------------------------- */

async function load() {

    if (!db) {

        syncStatus("bad");

        user = null;
        loan = null;
        borrowers = [];
        paymentsData = [];

        dashboard();

        return;
    }

    try {

        syncStatus("");

        const authResult =
            await db.auth.getUser();

        user =
            authResult.data?.user || null;

        /*
           Public users can read the loan.
        */

        const loanResult =
            await db
                .from("loans")
                .select("*")
                .order("created_at", {
                    ascending: true
                })
                .limit(1)
                .maybeSingle();

        if (loanResult.error) {

            syncStatus("bad");

            toast(
                loanResult.error.message,
                "error"
            );

            return;
        }

        loan = loanResult.data;

        if (loan) {

            const [
                borrowersResult,
                paymentsResult
            ] = await Promise.all([

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

            if (borrowersResult.error) {

                toast(
                    borrowersResult.error.message,
                    "error"
                );
            }

            if (paymentsResult.error) {

                toast(
                    paymentsResult.error.message,
                    "error"
                );
            }

            borrowers =
                borrowersResult.data || [];

            paymentsData =
                paymentsResult.data || [];

        } else {

            borrowers = [];
            paymentsData = [];
        }

        syncStatus("ok");

        dashboard();

    } catch (err) {

        syncStatus("bad");

        toast(
            err.message || "Cloud connection failed",
            "error"
        );
    }
}

/* -----------------------------
   DASHBOARD
----------------------------- */

function dashboard() {

    const d = $("dashboard");

    if (!d) return;

    if (!loan) {

        d.innerHTML = `
            <div class="hero">
                <div class="hero-icon">🏠</div>
                <small>DREAM HOME</small>
                <strong>Cloud Loan Tracker</strong>
                <p>
                    Public view is ready.
                    Owner sign-in is required
                    to create the loan.
                </p>
            </div>

            <div class="card">
                <h2>Welcome</h2>

                <p class="muted">
                    Tap the person icon at the top
                    to sign in as owner.
                </p>
            </div>
        `;

        return;
    }

    const result =
        calculateLoan();

    const minEMI =
        minimumEMI();

    const fixEMI =
        fixedEMI();

    const autoExtra =
        automaticExtraEMI();

    const paidMonths =
        paidEMICount();

    const originalTenure =
        Number(loan.tenure_months) || 0;

    const projected =
        projectedTenure();

    const progress =
        originalTenure
            ? Math.min(
                100,
                paidMonths /
                originalTenure *
                100
            )
            : 0;

    d.innerHTML = `

        <div class="hero dashboard-hero">

            <div>
                <small>REMAINING PRINCIPAL</small>

                <strong>
                    ${money(result.principal)}
                </strong>

                <p>
                    Original loan:
                    ${money(loan.total_amount)}
                </p>
            </div>

        </div>

        <div class="metrics">

            <div class="metric">
                <small>Minimum EMI</small>

                <strong>
                    ${money(minEMI)}
                </strong>
            </div>

            <div class="metric">
                <small>Fixed EMI</small>

                <strong>
                    ${money(fixEMI)}
                </strong>
            </div>

        </div>

        <div class="card emi-card">

            <div class="pt">

                <div>
                    <h2>EMI Progress</h2>

                    <div class="muted">
                        ${paidMonths}
                        of
                        ${originalTenure}
                        EMIs paid
                    </div>
                </div>

                <span class="pill">
                    ${Math.round(progress)}%
                </span>

            </div>

            <div class="progress-large">

                <i
                    style="width:${progress}%"
                ></i>

            </div>

            <div class="progress-labels">

                <span>
                    ${paidMonths} paid
                </span>

                <span>
                    ${Math.max(
                        0,
                        originalTenure -
                        paidMonths
                    )} remaining
                </span>

            </div>

            <div class="tenure-box">

                <div>
                    <small>Original tenure</small>
                    <b>${originalTenure} months</b>
                </div>

                <div>
                    <small>Projected tenure</small>

                    <b>
                        ${
                            projected === 999
                                ? "Not reducing"
                                : projected + " months"
                        }
                    </b>
                </div>

            </div>

        </div>

        <div class="card">

            <div class="summary-mini">

                <div>
                    <small>Interest paid</small>
                    <b>${money(result.interestPaid)}</b>
                </div>

                <div>
                    <small>Principal paid</small>
                    <b>
                        ${money(
                            result.principalPaid
                        )}
                    </b>
                </div>

                <div>
                    <small>Extra principal</small>
                    <b>
                        ${money(
                            result.extraPaid
                        )}
                    </b>
                </div>

                <div>
                    <small>Loan paid</small>

                    <b>
                        ${
                            loan.total_amount
                                ? Math.round(
                                    (
                                        (
                                            loan.total_amount -
                                            result.principal
                                        ) /
                                        loan.total_amount
                                    ) * 100
                                )
                                : 0
                        }%
                    </b>
                </div>

            </div>

        </div>

        ${
            isOwner()
                ? `
                <div class="actions">

                    <button
                        class="btn primary"
                        onclick="payment()"
                    >
                        ＋ Add Payment
                    </button>

                    <button
                        class="btn soft"
                        onclick="loanEdit()"
                    >
                        ⚙️ Loan Settings
                    </button>

                </div>
                `
                : ""
        }

    `;
}

/* -----------------------------
   PAYMENTS PAGE
----------------------------- */

function payments() {

    const d = $("payments");

    if (!d) return;

    if (!loan) {

        d.innerHTML = `
            <div class="card empty">
                No loan has been created yet.
            </div>
        `;

        return;
    }

    const months =
        getEMIMonths();

    const savedMonths =
        [...new Set(
            paymentsData.map(
                p => Number(p.month_no)
            )
        )].sort((a, b) => b - a);

    d.innerHTML = `

        <div class="card">

            <div class="pt">

                <div>
                    <h2>Payments</h2>

                    <div class="muted">
                        EMI starts from
                        ${months[0]?.label || "-"}
                    </div>
                </div>

                ${
                    isOwner()
                        ? `
                        <button
                            class="btn primary"
                            onclick="payment()"
                        >
                            ＋ Add
                        </button>
                        `
                        : ""
                }

            </div>

        </div>

        ${
            savedMonths.length
                ? savedMonths.map(monthNo => {

                    const rows =
                        getMonthPayments(monthNo);

                    const emi =
                        rows.reduce(
                            (a, x) =>
                                a +
                                (
                                    Number(
                                        x.emi_paid
                                    ) || 0
                                ),
                            0
                        );

                    const extra =
                        rows.reduce(
                            (a, x) =>
                                a +
                                (
                                    Number(
                                        x.extra_principal
                                    ) || 0
                                ),
                            0
                        );

                    const month =
                        months[monthNo - 1];

                    return `
                        <div class="card payment-card">

                            <div class="pt">

                                <div>
                                    <h3>
                                        ${month?.label || "Payment"}
                                    </h3>

                                    <div class="muted">
                                        EMI:
                                        ${money(emi)}
                                        &nbsp; · &nbsp;
                                        Extra:
                                        ${money(extra)}
                                    </div>
                                </div>

                                ${
                                    isOwner()
                                        ? `
                                        <button
                                            class="btn soft"
                                            onclick="payment(${monthNo})"
                                        >
                                            Edit
                                        </button>
                                        `
                                        : `
                                        <span class="pill">
                                            Saved
                                        </span>
                                        `
                                }

                            </div>

                        </div>
                    `;

                }).join("")
                : `
                    <div class="card empty">
                        No payments recorded yet.
                    </div>
                `
        }

    `;
}

/* -----------------------------
   PEOPLE
----------------------------- */

function people() {

    const d = $("people");

    if (!d) return;

    if (!loan) {

        d.innerHTML = `
            <div class="card empty">
                No loan created.
            </div>
        `;

        return;
    }

    const totalLoan =
        Number(loan.total_amount) || 0;

    d.innerHTML = `

        <div class="card">

            <div class="pt">

                <div>
                    <h2>People</h2>
                    <div class="muted">
                        Individual payment contribution
                    </div>
                </div>

                ${
                    isOwner()
                        ? `
                        <button
                            class="btn soft"
                            onclick="person()"
                        >
                            ＋ Add
                        </button>
                        `
                        : ""
                }

            </div>

        </div>

        ${
            borrowers.length
                ? borrowers.map(b => {

                    const paid =
                        paymentsData
                            .filter(
                                p =>
                                    p.borrower_id ===
                                    b.id
                            );

                    const emiPaid =
                        paid.reduce(
                            (a, p) =>
                                a +
                                (
                                    Number(
                                        p.emi_paid
                                    ) || 0
                                ),
                            0
                        );

                    const extra =
                        paid.reduce(
                            (a, p) =>
                                a +
                                (
                                    Number(
                                        p.extra_principal
                                    ) || 0
                                ),
                            0
                        );

                    const total =
                        emiPaid + extra;

                    const contribution =
                        totalLoan
                            ? (
                                total /
                                totalLoan *
                                100
                            )
                            : 0;

                    return `

                        <div class="card person-card">

                            <div class="person-header">

                                <div class="avatar">
                                    ${esc(
                                        (b.name || "P")
                                            .charAt(0)
                                            .toUpperCase()
                                    )}
                                </div>

                                <div>

                                    <h3>
                                        ${esc(b.name)}
                                    </h3>

                                    <div class="muted">
                                        Fixed EMI:
                                        ${money(
                                            b.scheduled_emi
                                        )}
                                    </div>

                                </div>

                                ${
                                    isOwner()
                                        ? `
                                        <button
                                            class="btn soft"
                                            onclick="person('${b.id}')"
                                        >
                                            Edit
                                        </button>
                                        `
                                        : ""
                                }

                            </div>

                            <div class="person-stats">

                                <div>
                                    <small>EMI paid</small>
                                    <b>
                                        ${money(emiPaid)}
                                    </b>
                                </div>

                                <div>
                                    <small>Extra principal</small>
                                    <b>
                                        ${money(extra)}
                                    </b>
                                </div>

                                <div>
                                    <small>Total paid</small>
                                    <b>
                                        ${money(total)}
                                    </b>
                                </div>

                                <div>
                                    <small>Contribution</small>
                                    <b>
                                        ${contribution.toFixed(1)}%
                                    </b>
                                </div>

                            </div>

                        </div>
                    `;

                }).join("")
                : `
                    <div class="card empty">
                        No people added.
                    </div>
                `
        }

    `;
}

/* -----------------------------
   REPORTS
----------------------------- */

function reports() {

    const d = $("reports");

    if (!d) return;

    if (!loan) {

        d.innerHTML = `
            <div class="card empty">
                No loan available.
            </div>
        `;

        return;
    }

    const result =
        calculateLoan();

    const min =
        minimumEMI();

    const fixed =
        fixedEMI();

    const autoExtra =
        automaticExtraEMI();

    const paidPercent =
        loan.total_amount
            ? (
                (
                    loan.total_amount -
                    result.principal
                ) /
                loan.total_amount *
                100
            )
            : 0;

    d.innerHTML = `

        <div class="card">

            <h2>Loan Summary</h2>

            <div class="report-row">
                <span>Original loan</span>
                <b>${money(loan.total_amount)}</b>
            </div>

            <div class="report-row">
                <span>Remaining principal</span>
                <b>${money(result.principal)}</b>
            </div>

            <div class="report-row">
                <span>Interest paid</span>
                <b>${money(result.interestPaid)}</b>
            </div>

            <div class="report-row">
                <span>Principal paid</span>
                <b>${money(result.principalPaid)}</b>
            </div>

            <div class="report-row">
                <span>Extra principal paid</span>
                <b>${money(result.extraPaid)}</b>
            </div>

            <div class="report-row">
                <span>Loan paid</span>
                <b>${paidPercent.toFixed(1)}%</b>
            </div>

            <div class="report-row">
                <span>Minimum EMI</span>
                <b>${money(min)}</b>
            </div>

            <div class="report-row">
                <span>Fixed EMI</span>
                <b>${money(fixed)}</b>
            </div>

            ${
                autoExtra > 0
                    ? `
                    <div class="report-row">
                        <span>Automatic extra principal</span>
                        <b>${money(autoExtra)}/month</b>
                    </div>
                    `
                    : ""
            }

            <div class="report-row">
                <span>Interest-only period</span>
                <b>
                    ${Number(
                        loan.interest_only_months
                    ) || 0} months
                </b>
            </div>

            <div class="report-row">
                <span>Original tenure</span>
                <b>
                    ${Number(
                        loan.tenure_months
                    ) || 0} months
                </b>
            </div>

            <div class="report-row">
                <span>Projected tenure</span>
                <b>
                    ${
                        projectedTenure() === 999
                            ? "Not reducing"
                            : projectedTenure() +
                              " months"
                    }
                </b>
            </div>

        </div>

        <div class="card">

            <h2>People</h2>

            ${
                borrowers.length
                    ? borrowers.map(b => {

                        const rows =
                            paymentsData.filter(
                                p =>
                                    p.borrower_id ===
                                    b.id
                            );

                        const emi =
                            rows.reduce(
                                (a, p) =>
                                    a +
                                    (
                                        Number(
                                            p.emi_paid
                                        ) || 0
                                    ),
                                0
                            );

                        const extra =
                            rows.reduce(
                                (a, p) =>
                                    a +
                                    (
                                        Number(
                                            p.extra_principal
                                        ) || 0
                                    ),
                                0
                            );

                        const total =
                            emi + extra;

                        const contribution =
                            loan.total_amount
                                ? total /
                                  loan.total_amount *
                                  100
                                : 0;

                        return `

                            <div class="report-person">

                                <div class="pt">

                                    <div>
                                        <h3>
                                            ${esc(b.name)}
                                        </h3>

                                        <div class="muted">
                                            Fixed EMI:
                                            ${money(
                                                b.scheduled_emi
                                            )}
                                        </div>
                                    </div>

                                    <span class="pill">
                                        ${contribution.toFixed(1)}%
                                    </span>

                                </div>

                                <div class="person-stats">

                                    <div>
                                        <small>EMI paid</small>
                                        <b>
                                            ${money(emi)}
                                        </b>
                                    </div>

                                    <div>
                                        <small>Extra principal</small>
                                        <b>
                                            ${money(extra)}
                                        </b>
                                    </div>

                                    <div>
                                        <small>Total paid</small>
                                        <b>
                                            ${money(total)}
                                        </b>
                                    </div>

                                    <div>
                                        <small>Contribution</small>
                                        <b>
                                            ${contribution.toFixed(1)}%
                                        </b>
                                    </div>

                                </div>

                            </div>

                        `;

                    }).join("")
                    : `
                        <div class="empty">
                            No people added.
                        </div>
                    `
            }

        </div>

    `;
}

/* -----------------------------
   MORE
----------------------------- */

function more() {

    const d = $("more");

    if (!d) return;

    d.innerHTML = `

        <div class="card">

            <div class="pt">

                <div>
                    <h2>Account</h2>

                    <div class="muted">
                        ${
                            user
                                ? "Owner account signed in"
                                : "Public view mode"
                        }
                    </div>
                </div>

                <span class="pill">
                    ${
                        user
                            ? "OWNER"
                            : "VIEW ONLY"
                    }
                </span>

            </div>

            <button
                class="btn ${
                    user
                        ? "soft"
                        : "primary"
                }"
                onclick="accountPopup()"
            >
                ${
                    user
                        ? "Sign out"
                        : "🔐 Owner sign in"
                }
            </button>

        </div>

        ${
            isOwner()
                ? `
                <div class="card">

                    <h2>Manage</h2>

                    <div class="row">
                        <b>Loan settings</b>

                        <button
                            class="btn soft"
                            onclick="loanEdit()"
                        >
                            Open
                        </button>
                    </div>

                    <div class="row">
                        <b>Reset loan</b>

                        <button
                            class="btn danger"
                            onclick="resetLoan()"
                        >
                            Reset
                        </button>
                    </div>

                </div>
                `
                : ""
        }

    `;
}

/* -----------------------------
   MODAL
----------------------------- */

function modal(html) {

    const m = $("modal");

    if (!m) return;

    $("mb").innerHTML = html;

    m.classList.add("open");
}

function closeModal() {

    const m = $("modal");

    if (m) {
        m.classList.remove("open");
    }
}

if ($("x")) {
    $("x").onclick = closeModal;
}

if ($("modal")) {

    $("modal").onclick = e => {

        if (e.target === $("modal")) {
            closeModal();
        }

    };
}

/* -----------------------------
   ACCOUNT POPUP
----------------------------- */

function accountPopup() {

    if (user) {

        modal(`

            <div class="popup-icon">👤</div>

            <h2>Owner account</h2>

            <p class="muted">
                Signed in as
                <b>${esc(user.email)}</b>
            </p>

            <button
                class="btn danger"
                onclick="out()"
            >
                Sign out
            </button>

        `);

        return;
    }

    auth();
}

/* -----------------------------
   AUTH
----------------------------- */

function auth() {

    if (!db) {

        toast(
            "Supabase is not connected.",
            "error"
        );

        return;
    }

    modal(`

        <div class="popup-icon">🔐</div>

        <h2>Owner sign in</h2>

        <p class="muted">
            Anyone can view Dream Home,
            but only the owner can edit
            loan data.
        </p>

        <label>
            Email
            <input
                id="ae"
                type="email"
                placeholder="Owner email"
            >
        </label>

        <label>
            Password
            <input
                id="ap"
                type="password"
                placeholder="Password"
            >
        </label>

        <button
            class="btn primary"
            onclick="login()"
        >
            Sign in
        </button>

        <button
            class="btn soft"
            onclick="signup()"
        >
            Create owner account
        </button>

    `);
}

/* -----------------------------
   LOGIN
----------------------------- */

async function login() {

    if (!db) return;

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

    closeModal();

    user =
        q.data.user;

    toast(
        "Welcome back, owner!",
        "success"
    );

    await load();

    nav("dashboard");
}

/* -----------------------------
   SIGN UP
----------------------------- */

async function signup() {

    if (!db) return;

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

    closeModal();

    if (q.data.user) {

        toast(
            "Owner account created.",
            "success"
        );

    } else {

        toast(
            "Check your email to confirm the account.",
            "success"
        );
    }

    await load();
}

/* -----------------------------
   SIGN OUT
----------------------------- */

async function out() {

    if (!db) return;

    await db.auth.signOut();

    closeModal();

    user = null;

    toast(
        "Signed out successfully.",
        "success"
    );

    await load();

    nav("dashboard");
}

/* -----------------------------
   LOAN SETTINGS
----------------------------- */

function loanEdit() {

    if (!isOwner()) {

        auth();

        return;
    }

    modal(`

        <div class="popup-icon">⚙️</div>

        <h2>Loan settings</h2>

        <div class="grid">

            <label class="full">
                Loan name

                <input
                    id="ln"
                    value="${esc(
                        loan.name ||
                        "Dream Home Loan"
                    )}"
                >
            </label>

            <label>
                Total loan

                <input
                    id="la"
                    type="number"
                    value="${Number(
                        loan.total_amount
                    ) || 0}"
                >
            </label>

            <label>
                Annual interest %

                <input
                    id="lr"
                    type="number"
                    step="0.01"
                    value="${Number(
                        loan.annual_rate
                    ) || 0}"
                >
            </label>

            <label>
                Tenure

                <input
                    id="lt"
                    type="number"
                    value="${Number(
                        loan.tenure_months
                    ) || 0}"
                >
            </label>

            <label>
                Loan start date

                <input
                    id="ls"
                    type="date"
                    value="${esc(
                        loan.start_date || ""
                    )}"
                >
            </label>

            <label>
                Interest-only months

                <input
                    id="li"
                    type="number"
                    min="0"
                    value="${Number(
                        loan.interest_only_months
                    ) || 0}"
                >
            </label>

        </div>

        <div class="info-box">

            <b>Minimum EMI</b>

            <span>
                Automatically calculated from
                loan amount, interest and tenure.
            </span>

        </div>

        <button
            class="btn primary"
            onclick="saveLoan()"
        >
            Save settings
        </button>

    `);
}

/* -----------------------------
   SAVE LOAN
----------------------------- */

async function saveLoan() {

    if (!isOwner()) return;

    const v = {

        name:
            $("ln").value.trim() ||
            "Dream Home Loan",

        total_amount:
            Number($("la").value) || 0,

        annual_rate:
            Number($("lr").value) || 0,

        tenure_months:
            Number($("lt").value) || 0,

        start_date:
            $("ls").value,

        interest_only_months:
            Number($("li").value) || 0,

        updated_at:
            new Date().toISOString()

    };

    if (
        v.total_amount <= 0 ||
        v.tenure_months <= 0
    ) {

        toast(
            "Enter valid loan amount and tenure.",
            "error"
        );

        return;
    }

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

    loan = q.data;

    closeModal();

    toast(
        "Loan settings updated.",
        "success"
    );

    await load();
}

/* -----------------------------
   BORROWER
----------------------------- */

function person(id) {

    if (!isOwner()) {

        auth();

        return;
    }

    const b =
        borrowers.find(
            x => x.id === id
        ) || {
            name: "",
            scheduled_emi: 0
        };

    modal(`

        <div class="popup-icon">👤</div>

        <h2>
            ${id ? "Edit person" : "Add person"}
        </h2>

        <label>
            Name

            <input
                id="bn"
                value="${esc(
                    b.name
                )}"
                placeholder="Person name"
            >
        </label>

        <label>
            Fixed monthly EMI

            <input
                id="be"
                type="number"
                value="${Number(
                    b.scheduled_emi
                ) || 0}"
                placeholder="₹"
            >
        </label>

        <button
            class="btn primary"
            onclick="savePerson('${id || ""}')"
        >
            Save person
        </button>

        ${
            id
                ? `
                <button
                    class="btn danger"
                    onclick="deletePerson('${id}')"
                >
                    Delete person
                </button>
                `
                : ""
        }

    `);
}

/* -----------------------------
   SAVE PERSON
----------------------------- */

async function savePerson(id) {

    if (!isOwner()) return;

    const v = {

        loan_id: loan.id,

        name:
            $("bn").value.trim() ||
            "Person",

        scheduled_emi:
            Number($("be").value) || 0,

        sort_order:
            id
                ? (
                    borrowers.find(
                        b => b.id === id
                    )?.sort_order || 0
                )
                : borrowers.length

    };

    let q;

    if (id) {

        q =
            await db
                .from("borrowers")
                .update(v)
                .eq("id", id)
                .select()
                .single();

    } else {

        q =
            await db
                .from("borrowers")
                .insert(v)
                .select()
                .single();
    }

    if (q.error) {

        toast(
            q.error.message,
            "error"
        );

        return;
    }

    closeModal();

    toast(
        "Person saved.",
        "success"
    );

    await load();
}

/* -----------------------------
   DELETE PERSON
----------------------------- */

async function deletePerson(id) {

    if (!isOwner()) return;

    if (
        !confirm(
            "Delete this person and their payment records?"
        )
    ) return;

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

    closeModal();

    toast(
        "Person deleted.",
        "success"
    );

    await load();
}

/* -----------------------------
   PAYMENT POPUP
----------------------------- */

function payment(editMonth = null) {

    if (!isOwner()) {

        auth();

        return;
    }

    const months =
        getEMIMonths();

    if (!months.length) {

        toast(
            "Set the loan start date and tenure first.",
            "error"
        );

        return;
    }

    let selected =
        editMonth
            ? Number(editMonth)
            : null;

    /*
       If adding new payment,
       automatically choose first unpaid month.
    */

    if (!selected) {

        for (const m of months) {

            const exists =
                paymentsData.some(
                    p =>
                        Number(p.month_no) ===
                        m.no
                );

            if (!exists) {

                selected = m.no;

                break;
            }
        }

        if (!selected) {

            selected =
                months[months.length - 1].no;
        }
    }

    renderPaymentPopup(selected);
}

/* -----------------------------
   RENDER PAYMENT POPUP
----------------------------- */

function renderPaymentPopup(monthNo) {

    const months =
        getEMIMonths();

    const month =
        months[monthNo - 1];

    if (!month) return;

    modal(`

        <div class="popup-icon">💰</div>

        <h2>Payment</h2>

        <label>
            EMI Month

            <select
                id="paymentMonth"
                onchange="renderPaymentPopup(Number(this.value))"
            >

                ${months.map(m => `
                    <option
                        value="${m.no}"
                        ${
                            m.no === monthNo
                                ? "selected"
                                : ""
                        }
                    >
                        ${m.label}
                    </option>
                `).join("")}

            </select>

        </label>

        <div class="info-box">

            <b>${month.label}</b>

            <span>
                Fixed EMI is automatically included.
                Enter only the extra principal
                contribution for each person.
            </span>

        </div>

        <div id="paymentPeople">

            ${borrowers.map(b => {

                const p =
                    getPayment(
                        monthNo,
                        b.id
                    );

                return `

                    <div class="pay-person">

                        <div class="pt">

                            <div>
                                <b>
                                    ${esc(b.name)}
                                </b>

                                <div class="muted">
                                    Fixed EMI:
                                    ${money(
                                        b.scheduled_emi
                                    )}
                                </div>
                            </div>

                        </div>

                        <label>
                            Extra principal

                            <input
                                id="extra_${b.id}"
                                type="number"
                                min="0"
                                value="${
                                    Number(
                                        p.extra_principal
                                    ) || ""
                                }"
                                placeholder="₹ 0"
                            >
                        </label>

                    </div>

                `;

            }).join("")}

        </div>

        <button
            class="btn primary"
            onclick="savePayment(${monthNo})"
        >
            ✓ Pay & Save
        </button>

    `);
}

/* -----------------------------
   SAVE PAYMENT
----------------------------- */

async function savePayment(monthNo) {

    if (!isOwner()) return;

    if (!borrowers.length) {

        toast(
            "Add at least one person first.",
            "error"
        );

        return;
    }

    /*
       Fixed EMI is automatically considered
       paid for every person.

       The database stores it in emi_paid.
    */

    for (const b of borrowers) {

        const extra =
            Number(
                $("extra_" + b.id)?.value
            ) || 0;

        const v = {

            loan_id: loan.id,

            borrower_id: b.id,

            month_no: monthNo,

            payment_date:
                new Date()
                    .toISOString()
                    .slice(0, 10),

            emi_paid:
                Number(
                    b.scheduled_emi
                ) || 0,

            extra_principal:
                extra

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

            toast(
                q.error.message,
                "error"
            );

            return;
        }
    }

    closeModal();

    toast(
        "Payment saved to cloud.",
        "success"
    );

    await load();

    nav("payments");
}

/* -----------------------------
   RESET LOAN
----------------------------- */

async function resetLoan() {

    if (!isOwner()) {

        auth();

        return;
    }

    modal(`

        <div class="popup-icon">⚠️</div>

        <h2>Reset loan?</h2>

        <p class="muted">
            This will permanently delete
            the current loan, people and
            payment records from the cloud.
        </p>

        <p>
            <b>This cannot be undone.</b>
        </p>

        <button
            class="btn danger"
            onclick="confirmResetLoan()"
        >
            Yes, reset loan
        </button>

        <button
            class="btn soft"
            onclick="closeModal()"
        >
            Cancel
        </button>

    `);
}

/* -----------------------------
   CONFIRM RESET
----------------------------- */

async function confirmResetLoan() {

    if (!isOwner()) return;

    try {

        /*
           Delete payment records first.
        */

        let q =
            await db
                .from("monthly_payments")
                .delete()
                .eq("loan_id", loan.id);

        if (q.error) throw q.error;

        /*
           Delete borrowers.
        */

        q =
            await db
                .from("borrowers")
                .delete()
                .eq("loan_id", loan.id);

        if (q.error) throw q.error;

        /*
           Delete loan.
        */

        q =
            await db
                .from("loans")
                .delete()
                .eq("id", loan.id);

        if (q.error) throw q.error;

        closeModal();

        loan = null;
        borrowers = [];
        paymentsData = [];

        toast(
            "Loan reset successfully.",
            "success"
        );

        await load();

        nav("dashboard");

    } catch (err) {

        toast(
            err.message ||
            "Unable to reset loan.",
            "error"
        );
    }
}

/* -----------------------------
   PAYMENT HISTORY
----------------------------- */

function history() {

    if (!loan) return;

    const months =
        getEMIMonths();

    let rows = "";

    paymentsData
        .slice()
        .sort(
            (a, b) =>
                Number(b.month_no) -
                Number(a.month_no)
        )
        .forEach(p => {

            const month =
                months[
                    Number(p.month_no) - 1
                ];

            const b =
                borrowers.find(
                    x =>
                        x.id ===
                        p.borrower_id
                );

            rows += `

                <tr>

                    <td>
                        ${month?.label || "-"}
                    </td>

                    <td>
                        ${esc(
                            b?.name || "-"
                        )}
                    </td>

                    <td>
                        ${money(
                            p.emi_paid
                        )}
                    </td>

                    <td>
                        ${money(
                            p.extra_principal
                        )}
                    </td>

                </tr>

            `;
        });

    modal(`

        <div class="popup-icon">📜</div>

        <h2>Payment history</h2>

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
                        </tr>

                        ${rows}

                    </table>
                </div>
                `
                : `
                <div class="empty">
                    No payments recorded.
                </div>
                `
        }

    `);
}

/* -----------------------------
   TOP ACCOUNT BUTTON
----------------------------- */

if ($("account")) {

    $("account").onclick =
        accountPopup;
}

/* -----------------------------
   NAV BUTTONS
----------------------------- */

document
    .querySelectorAll("nav button")
    .forEach(button => {

        button.onclick = () =>
            nav(button.dataset.s);

    });

/* -----------------------------
   SUPABASE AUTH LISTENER
----------------------------- */

if (db) {

    db.auth.onAuthStateChange(
        (event, session) => {

            setTimeout(
                async () => {

                    user =
                        session?.user || null;

                    await load();

                },
                0
            );

        }
    );

    load();

} else {

    dashboard();
}

/* -----------------------------
   SERVICE WORKER
----------------------------- */

if (
    "serviceWorker" in navigator
) {

    navigator.serviceWorker
        .register("./sw.js")
        .catch(() => {});

}

/* -----------------------------
   START
----------------------------- */

nav("dashboard");
