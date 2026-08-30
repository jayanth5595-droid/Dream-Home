/* =========================================================
   DREAM HOME v3
   Cloud synced loan tracker
   Public view + Owner-only editing

   CHANGES IN THIS VERSION:
   1. Dashboard shows Minimum EMI and Fixed EMI separately.
   2. Removes "EMI Paid" and "New Tenure" dashboard cells.
   3. Removes everything below Loan Settings on dashboard.
   4. Payment month starts from the month AFTER loan start date.
   5. Each person gets a separate colored card in People/Reports.
   6. Minimum EMI = automatic loan EMI.
      Fixed EMI = total of all persons' fixed EMIs.
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


/* =========================================================
   HELPERS
   ========================================================= */

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
        .replaceAll('"', "&quot;");

function toast(t) {
    if (!$("toast")) return;

    $("toast").textContent = t;
    $("toast").style.display = "block";

    setTimeout(() => {
        $("toast").style.display = "none";
    }, 2200);
}

function sync(x) {
    if (!$("sync")) return;

    $("sync").className =
        x === "ok" ? "ok" :
        x === "bad" ? "bad" : "";
}

function edit() {
    return !!user && !!loan && loan.created_by === user.id;
}


/* =========================================================
   INTEREST / EMI
   ========================================================= */

function rate() {
    return (+loan.annual_rate || 0) / 1200;
}


/*
   Minimum EMI:
   Automatically calculated from:
   Loan amount + interest rate + tenure
*/
function minimumEMI() {
    if (!loan) return 0;

    const p = +loan.total_amount || 0;
    const n = +loan.tenure_months || 0;
    const r = rate();

    if (!p || !n) return 0;

    if (!r) return p / n;

    return (
        p *
        r *
        Math.pow(1 + r, n) /
        (Math.pow(1 + r, n) - 1)
    );
}


/*
   Fixed EMI:
   Sum of all persons' fixed EMI amounts.
*/
function fixedEMI() {
    return bs.reduce(
        (total, b) => total + (+b.scheduled_emi || 0),
        0
    );
}


/*
   Keep old overall() compatibility.
*/
function overall() {
    return minimumEMI();
}


/* =========================================================
   PAYMENT HELPERS
   ========================================================= */

function pay(monthNo, borrowerId) {
    return (
        ps.find(
            x =>
                x.month_no === monthNo &&
                x.borrower_id === borrowerId
        ) || {
            emi_paid: 0,
            extra_principal: 0
        }
    );
}


/* =========================================================
   EMI MONTH CALCULATIONS
   ========================================================= */

/*
   If loan starts in August 2026,
   first EMI month = September 2026.
*/

function firstEMIDate() {
    if (!loan || !loan.start_date) return null;

    const d = new Date(loan.start_date + "T00:00:00");

    return new Date(
        d.getFullYear(),
        d.getMonth() + 1,
        1
    );
}


function monthDate(monthNo) {
    const first = firstEMIDate();

    if (!first) return null;

    return new Date(
        first.getFullYear(),
        first.getMonth() + (monthNo - 1),
        1
    );
}


function monthLabel(monthNo) {
    const d = monthDate(monthNo);

    if (!d) return `Month ${monthNo}`;

    return d.toLocaleDateString("en-US", {
        month: "short",
        year: "numeric"
    });
}


function monthOptions() {
    if (!loan) return "";

    let html = "";

    for (
        let m = 1;
        m <= (+loan.tenure_months || 0);
        m++
    ) {
        html += `
            <option value="${m}">
                ${monthLabel(m)}
            </option>
        `;
    }

    return html;
}


/* =========================================================
   GLOBAL LOAN CALCULATION
   ========================================================= */

/*
   Calculates the loan as ONE loan.

   Principal is NOT divided between persons.

   Regular fixed EMI:
   - Total fixed EMI of all persons
   - Interest calculated on full outstanding principal

   Extra principal:
   - Goes directly against full outstanding principal
   - Contribution remains linked to the person who paid it

   Interest is recalculated every month based on
   the remaining full-loan principal.
*/

function calculateLoan(upToMonth = loan?.tenure_months || 0) {

    if (!loan) {
        return {
            balance: 0,
            interestPaid: 0,
            principalPaid: 0,
            extraPaid: 0,
            totalPaid: 0,
            unpaidInterest: 0,
            monthsPaid: 0
        };
    }

    let balance = +loan.total_amount || 0;
    let interestPaid = 0;
    let principalPaid = 0;
    let extraPaid = 0;
    let totalPaid = 0;
    let unpaidInterest = 0;
    let monthsPaid = 0;

    const r = rate();

    const interestOnly =
        +loan.interest_only_months || 0;

    for (
        let m = 1;
        m <= upToMonth;
        m++
    ) {

        const records = ps.filter(
            x => x.month_no === m
        );

        /*
           A month is considered paid only when
           there is at least one payment record.
        */
        if (!records.length) continue;

        monthsPaid++;

        const interest = balance * r;

        let regularPaid = 0;
        let monthExtra = 0;

        records.forEach(x => {

            /*
               Fixed EMI is automatically counted.
            */
            const person =
                bs.find(
                    b => b.id === x.borrower_id
                );

            if (person) {
                regularPaid +=
                    +person.scheduled_emi || 0;
            }

            monthExtra +=
                +x.extra_principal || 0;
        });

        totalPaid += regularPaid + monthExtra;

        /*
           Interest is paid first.
        */
        const interestPayment =
            Math.min(
                regularPaid,
                interest
            );

        interestPaid += interestPayment;

        unpaidInterest +=
            Math.max(
                0,
                interest - regularPaid
            );

        /*
           During interest-only period,
           regular EMI does NOT reduce principal.
        */
        let regularPrincipal = 0;

        if (m > interestOnly) {

            regularPrincipal =
                Math.min(
                    Math.max(
                        0,
                        regularPaid - interest
                    ),
                    balance
                );
        }

        /*
           Extra payment ALWAYS reduces principal.
        */
        const availableAfterRegular =
            Math.max(
                0,
                balance - regularPrincipal
            );

        const extraPrincipal =
            Math.min(
                monthExtra,
                availableAfterRegular
            );

        balance -=
            regularPrincipal +
            extraPrincipal;

        balance = Math.max(0, balance);

        principalPaid += regularPrincipal;
        extraPaid += extraPrincipal;
    }

    return {
        balance,
        interestPaid,
        principalPaid,
        extraPaid,
        totalPaid,
        unpaidInterest,
        monthsPaid
    };
}


/* =========================================================
   PERSON CALCULATION
   ========================================================= */

function personStats(person) {

    let emiPaid = 0;
    let extraPaid = 0;
    let totalPaid = 0;

    ps
        .filter(x => x.borrower_id === person.id)
        .forEach(x => {

            emiPaid +=
                +person.scheduled_emi || 0;

            extraPaid +=
                +x.extra_principal || 0;
        });

    totalPaid =
        emiPaid +
        extraPaid;

    const allPaid =
        bs.reduce((sum, b) => {

            const p =
                ps.filter(
                    x => x.borrower_id === b.id
                ).length;

            return sum +
                p * (+b.scheduled_emi || 0) +
                ps
                    .filter(
                        x => x.borrower_id === b.id
                    )
                    .reduce(
                        (a, x) =>
                            a + (+x.extra_principal || 0),
                        0
                    );

        }, 0);

    const contribution =
        allPaid > 0
            ? totalPaid / allPaid * 100
            : 0;

    return {
        emiPaid,
        extraPaid,
        totalPaid,
        contribution
    };
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

    if ($(id)) {
        $(id).classList.add("active");
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
    .forEach(x => {

        x.onclick = () =>
            nav(x.dataset.s);

    });


/* =========================================================
   LOAD CLOUD DATA
   ========================================================= */

async function load() {

    if (!db) {

        sync("bad");
        dashboard();

        return;
    }

    sync("");

    const q =
        await db.auth.getUser();

    user =
        q.data.user || null;

    const l =
        await db
            .from("loans")
            .select("*")
            .order("created_at")
            .limit(1)
            .maybeSingle();

    if (l.error) {

        toast(l.error.message);
        sync("bad");

        return;
    }

    loan = l.data;

    if (loan) {

        const [
            b,
            p
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

        bs = b.data || [];
        ps = p.data || [];

    } else {

        bs = [];
        ps = [];
    }

    sync("ok");

    dashboard();
}


/* =========================================================
   DASHBOARD
   ========================================================= */

function dashboard() {

    if (!loan) {

        $("dashboard").innerHTML = `

            <div class="hero">
                <small>DREAM HOME</small>
                <strong>Public view ready</strong>

                <div>
                    Owner sign-in is required
                    to create the cloud loan.
                </div>
            </div>

            <div class="card">

                <h2>Cloud setup</h2>

                <p class="muted">
                    ${
                        ready
                            ? "No loan has been created yet."
                            : "Add your Supabase URL and key to config.js, then redeploy."
                    }
                </p>

                <button
                    class="btn primary"
                    onclick="auth()"
                >
                    🔐 Owner sign in
                </button>

            </div>
        `;

        return;
    }


    const calc =
        calculateLoan(
            loan.tenure_months
        );


    const minEMI =
        minimumEMI();

    const fixEMI =
        fixedEMI();


    const paidPercentage =
        loan.total_amount > 0
            ? (
                (
                    loan.total_amount -
                    calc.balance
                ) /
                loan.total_amount
            ) * 100
            : 0;


    const safePercentage =
        Math.max(
            0,
            Math.min(
                100,
                paidPercentage
            )
        );


    const emiProgress =
        loan.tenure_months > 0
            ? Math.min(
                100,
                (
                    calc.monthsPaid /
                    loan.tenure_months
                ) * 100
            )
            : 0;


    $("dashboard").innerHTML = `

        <!-- REMAINING PRINCIPAL -->

        <div class="hero">

            <small>
                REMAINING PRINCIPAL
            </small>

            <strong>
                ${M(calc.balance)}
            </strong>

            <div>
                ${M(loan.total_amount)}
                original ·
                ${loan.annual_rate}%
                ·
                ${loan.tenure_months}
                months
            </div>

        </div>


        <!-- EMI CELLS -->

        <div class="metrics">

            <div class="metric">

                <small>
                    Minimum EMI
                </small>

                <strong>
                    ${M(minEMI)}
                </strong>

            </div>


            <div class="metric">

                <small>
                    Fixed EMI
                </small>

                <strong>
                    ${M(fixEMI)}
                </strong>

            </div>


            <div class="metric">

                <small>
                    Principal Paid
                </small>

                <strong>
                    ${M(
                        calc.principalPaid +
                        calc.extraPaid
                    )}
                </strong>

            </div>


            <div class="metric">

                <small>
                    Interest Paid
                </small>

                <strong>
                    ${M(calc.interestPaid)}
                </strong>

            </div>

        </div>


        <!-- LOAN PAID -->

        <div class="card">

            <div class="pt">

                <h2>
                    Loan Paid
                </h2>

                <b>
                    ${safePercentage.toFixed(1)}%
                </b>

            </div>

            <div class="bar">

                <i
                    style="
                        width:${safePercentage}%
                    "
                ></i>

            </div>

        </div>


        <!-- EMI PROGRESS -->

        <div class="card">

            <div class="pt">

                <h2>
                    EMI Progress
                </h2>

                <b>
                    ${calc.monthsPaid}
                    /
                    ${loan.tenure_months}
                </b>

            </div>

            <div class="bar">

                <i
                    style="
                        width:${emiProgress}%
                    "
                ></i>

            </div>

        </div>


        <!-- OWNER ACTIONS ONLY -->

        ${
            edit()
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


/* =========================================================
   PEOPLE
   ========================================================= */

function people() {

    const colors = [
        "person-a",
        "person-b",
        "person-c",
        "person-d",
        "person-e",
        "person-f"
    ];


    $("people").innerHTML = `

        <div class="card">

            <div class="pt">

                <h2>
                    People
                </h2>

                ${
                    edit()
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


            ${
                bs.length
                    ? bs.map((b, index) => {

                        const s =
                            personStats(b);

                        return `

                            <div
                                class="person ${colors[index % colors.length]}"
                            >

                                <div class="pt">

                                    <b>
                                        ${esc(b.name)}
                                    </b>

                                    <span class="pill">
                                        ${M(
                                            b.scheduled_emi
                                        )}/mo
                                    </span>

                                </div>


                                <div class="row">

                                    <span>
                                        EMI amount paid
                                    </span>

                                    <b>
                                        ${M(s.emiPaid)}
                                    </b>

                                </div>


                                <div class="row">

                                    <span>
                                        Extra principal paid
                                    </span>

                                    <b>
                                        ${M(s.extraPaid)}
                                    </b>

                                </div>


                                <div class="row">

                                    <span>
                                        Total amount paid
                                    </span>

                                    <b>
                                        ${M(s.totalPaid)}
                                    </b>

                                </div>


                                <div class="row">

                                    <span>
                                        Payment contribution
                                    </span>

                                    <b>
                                        ${s.contribution.toFixed(1)}%
                                    </b>

                                </div>


                                ${
                                    edit()
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

                        `;

                    }).join("")
                    : `
                        <div class="empty">
                            No borrowers added.
                        </div>
                    `
            }

        </div>

    `;
}


/* =========================================================
   PAYMENTS
   ========================================================= */

function payments() {

    const months =
        [
            ...new Set(
                ps.map(x => x.month_no)
            )
        ].sort((a, b) => a - b);


    $("payments").innerHTML = `

        <div class="card">

            <div class="pt">

                <div>

                    <h2>
                        Payments
                    </h2>

                    <div class="muted">

                        ${
                            months.length
                        }
                        month(s) saved

                    </div>

                </div>


                ${
                    edit()
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


            ${
                months.length
                    ? months
                        .map(m => {

                            const q =
                                ps.filter(
                                    x =>
                                        x.month_no === m
                                );

                            const emi =
                                q.reduce(
                                    (a, x) => {

                                        const b =
                                            bs.find(
                                                z =>
                                                    z.id ===
                                                    x.borrower_id
                                            );

                                        return a +
                                            (
                                                b
                                                    ? +b.scheduled_emi
                                                    : 0
                                            );

                                    },
                                    0
                                );


                            const extra =
                                q.reduce(
                                    (a, x) =>
                                        a +
                                        (+x.extra_principal || 0),
                                    0
                                );


                            return `

                                <div class="row">

                                    <div>

                                        <b>
                                            ${monthLabel(m)}
                                        </b>

                                        <div class="muted">

                                            EMI
                                            ${M(emi)}

                                            ·

                                            Extra
                                            ${M(extra)}

                                        </div>

                                    </div>


                                    ${
                                        edit()
                                            ? `
                                                <button
                                                    class="btn soft"
                                                    onclick="payment(${m})"
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

                            `;

                        }).join("")
                    : `
                        <div class="empty">
                            No payments recorded.
                        </div>
                    `
            }

        </div>

    `;
}


/* =========================================================
   REPORTS
   ========================================================= */

function reports() {

    if (!loan) {

        $("reports").innerHTML =
            `<div class="empty">
                No loan created yet.
            </div>`;

        return;
    }


    const calc =
        calculateLoan(
            loan.tenure_months
        );


    const colors = [
        "person-a",
        "person-b",
        "person-c",
        "person-d",
        "person-e",
        "person-f"
    ];


    $("reports").innerHTML = `

        <div class="card">

            <h2>
                Loan Summary
            </h2>


            <div class="row">

                <span>
                    Original loan
                </span>

                <b>
                    ${M(loan.total_amount)}
                </b>

            </div>


            <div class="row">

                <span>
                    Remaining principal
                </span>

                <b>
                    ${M(calc.balance)}
                </b>

            </div>


            <div class="row">

                <span>
                    Principal paid
                </span>

                <b>
                    ${M(
                        calc.principalPaid +
                        calc.extraPaid
                    )}
                </b>

            </div>


            <div class="row">

                <span>
                    Interest paid
                </span>

                <b>
                    ${M(calc.interestPaid)}
                </b>

            </div>


            <div class="row">

                <span>
                    Minimum EMI
                </span>

                <b>
                    ${M(minimumEMI())}
                </b>

            </div>


            <div class="row">

                <span>
                    Fixed EMI
                </span>

                <b>
                    ${M(fixedEMI())}
                </b>

            </div>


            <div class="row">

                <span>
                    Loan paid
                </span>

                <b>
                    ${
                        loan.total_amount
                            ? (
                                (
                                    loan.total_amount -
                                    calc.balance
                                ) /
                                loan.total_amount *
                                100
                            ).toFixed(1)
                            : "0.0"
                    }%
                </b>

            </div>

        </div>


        <div class="card">

            <h2>
                People
            </h2>


            ${
                bs.map((b, index) => {

                    const s =
                        personStats(b);

                    return `

                        <div
                            class="person ${colors[index % colors.length]}"
                        >

                            <div class="pt">

                                <h3>
                                    ${esc(b.name)}
                                </h3>

                                <span class="pill">
                                    Fixed EMI
                                    ${M(
                                        b.scheduled_emi
                                    )}
                                </span>

                            </div>


                            <div class="row">

                                <span>
                                    EMI amount paid
                                </span>

                                <b>
                                    ${M(s.emiPaid)}
                                </b>

                            </div>


                            <div class="row">

                                <span>
                                    Extra principal paid
                                </span>

                                <b>
                                    ${M(s.extraPaid)}
                                </b>

                            </div>


                            <div class="row">

                                <span>
                                    Total amount paid
                                </span>

                                <b>
                                    ${M(s.totalPaid)}
                                </b>

                            </div>


                            <div class="row">

                                <span>
                                    Payment contribution
                                </span>

                                <b>
                                    ${s.contribution.toFixed(1)}%
                                </b>

                            </div>

                        </div>

                    `;

                }).join("")
            }

        </div>

    `;
}


/* =========================================================
   MORE
   ========================================================= */

function more() {

    $("more").innerHTML = `

        <div class="card">

            <h2>
                Account
            </h2>

            <div class="muted">

                ${
                    user
                        ? `
                            Signed in as
                            ${esc(user.email)}
                            — owner editing enabled.
                        `
                        : `
                            Public view mode —
                            owner only can edit.
                        `
                }

            </div>


            <button
                class="btn ${
                    user ? "soft" : "primary"
                }"
                onclick="${
                    user
                        ? "out()"
                        : "auth()"
                }"
            >

                ${
                    user
                        ? "Sign out"
                        : "🔐 Owner sign in"
                }

            </button>

        </div>


        <div class="card">

            <h2>
                Manage
            </h2>


            ${
                edit()
                    ? `
                        <div class="row">

                            <b>
                                Loan settings
                            </b>

                            <button
                                class="btn soft"
                                onclick="loanEdit()"
                            >
                                Open
                            </button>

                        </div>
                    `
                    : ""
            }


            <div class="row">

                <b>
                    Payment history
                </b>

                <button
                    class="btn soft"
                    onclick="history()"
                >
                    Open
                </button>

            </div>

        </div>

    `;
}


/* =========================================================
   MODAL
   ========================================================= */

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


/* =========================================================
   AUTHENTICATION
   ========================================================= */

function auth() {

    if (!db) {

        toast(
            "Supabase is not configured."
        );

        return;
    }


    modal(`

        <h2>
            Owner sign in
        </h2>

        <p class="muted">
            Only the owner account can edit
            cloud data.
        </p>


        <label>
            Email

            <input
                id="ae"
                type="email"
                autocomplete="email"
            >

        </label>


        <label>
            Password

            <input
                id="ap"
                type="password"
                autocomplete="current-password"
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


async function login() {

    const q =
        await db.auth.signInWithPassword({
            email: $("ae").value,
            password: $("ap").value
        });


    if (q.error) {

        toast(q.error.message);

        return;
    }


    close();

    toast("Signed in successfully");

    load();
}


async function signup() {

    const q =
        await db.auth.signUp({
            email: $("ae").value,
            password: $("ap").value
        });


    if (q.error) {

        toast(q.error.message);

        return;
    }


    toast(
        q.data.user
            ? "Owner account created"
            : "Account created"
    );

    close();

    load();
}


async function out() {

    await db.auth.signOut();

    toast("Signed out");

    load();
}


/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {

    if (!edit()) {

        auth();

        return;
    }


    modal(`

        <h2>
            Loan settings
        </h2>


        <div class="grid">

            <label class="full">

                Name

                <input
                    id="ln"
                    value="${esc(loan.name)}"
                >

            </label>


            <label>

                Total loan

                <input
                    id="la"
                    type="number"
                    value="${loan.total_amount}"
                >

            </label>


            <label>

                Annual interest %

                <input
                    id="lr"
                    type="number"
                    step=".01"
                    value="${loan.annual_rate}"
                >

            </label>


            <label>

                Tenure months

                <input
                    id="lt"
                    type="number"
                    value="${loan.tenure_months}"
                >

            </label>


            <label>

                Start date

                <input
                    id="ls"
                    type="date"
                    value="${loan.start_date}"
                >

            </label>


            <label>

                Interest-only months

                <input
                    id="li"
                    type="number"
                    min="0"
                    value="${loan.interest_only_months || 0}"
                >

            </label>

        </div>


        <p class="muted">

            Minimum EMI is automatically calculated
            from loan amount, interest rate and tenure.

            Fixed EMI is the total of the fixed EMI
            amounts assigned to all people.

        </p>


        <button
            class="btn primary"
            onclick="saveLoan()"
        >
            Save
        </button>

    `);
}


async function saveLoan() {

    const v = {

        name:
            $("ln").value.trim() ||
            "Dream Home Loan",

        total_amount:
            +$("la").value,

        annual_rate:
            +$("lr").value,

        tenure_months:
            +$("lt").value,

        start_date:
            $("ls").value,

        interest_only_months:
            +$("li").value || 0,

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

        toast(q.error.message);

        return;
    }


    close();

    toast("Loan settings saved");

    load();
}


/* =========================================================
   PERSON
   ========================================================= */

function person(id) {

    if (!edit()) {

        auth();

        return;
    }


    const b =
        bs.find(x => x.id === id) || {

            name: "New Person",
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
                value="${esc(b.name)}"
            >

        </label>


        <label>

            Fixed monthly EMI

            <input
                id="be"
                type="number"
                value="${b.scheduled_emi || ""}"
            >

        </label>


        <p class="muted">

            Fixed EMI is included automatically
            when this person's monthly payment
            is marked as paid.

        </p>


        <button
            class="btn primary"
            onclick="savePerson('${id || ""}')"
        >
            Save borrower
        </button>


        ${
            id
                ? `
                    <button
                        class="btn danger"
                        onclick="delPerson('${id}')"
                    >
                        Delete
                    </button>
                `
                : ""
        }

    `);
}


async function savePerson(id) {

    const v = {

        loan_id:
            loan.id,

        name:
            $("bn").value.trim() ||
            "Person",

        scheduled_emi:
            +$("be").value || 0,

        sort_order:
            id
                ? (
                    bs.find(
                        x => x.id === id
                    )?.sort_order || 0
                )
                : bs.length
    };


    const q =
        id
            ? await db
                .from("borrowers")
                .update(v)
                .eq("id", id)
                .select()
                .single()

            : await db
                .from("borrowers")
                .insert(v)
                .select()
                .single();


    if (q.error) {

        toast(q.error.message);

        return;
    }


    close();

    toast("Borrower saved");

    load();
}


async function delPerson(id) {

    if (
        !confirm(
            "Delete borrower and their payments?"
        )
    ) return;


    const q =
        await db
            .from("borrowers")
            .delete()
            .eq("id", id);


    if (q.error) {

        toast(q.error.message);

        return;
    }


    close();

    toast("Borrower deleted");

    load();
}


/* =========================================================
   ADD / EDIT PAYMENT
   ========================================================= */

function payment(existingMonth) {

    if (!edit()) {

        auth();

        return;
    }


    let m =
        existingMonth || 1;


    /*
       If adding a new payment,
       show a month dropdown instead of
       asking for 1,2,3...
    */

    modal(`

        <h2>
            ${existingMonth ? "Edit" : "Add"} Payment
        </h2>


        <label>

            EMI Month

            <select id="pm">
                ${monthOptions()}
            </select>

        </label>


        <p class="muted">

            Fixed EMI is automatically included.
            Enter only the extra principal amount
            paid by each person.

        </p>


        <div id="prs"></div>


        <button
            class="btn primary"
            onclick="savePayment()"
        >
            Save Payment
        </button>

    `);


    $("pm").value = m;


    function renderPaymentPeople() {

        const month =
            +$("pm").value;


        $("prs").innerHTML =
            bs.map(b => {

                const e =
                    pay(month, b.id);

                return `

                    <div class="pay">

                        <div class="pt">

                            <b>
                                ${esc(b.name)}
                            </b>

                            <span class="pill">
                                Fixed EMI
                                ${M(
                                    b.scheduled_emi
                                )}
                            </span>

                        </div>


                        <label>

                            Extra principal paid

                            <input
                                id="x${b.id}"
                                type="number"
                                min="0"
                                step="1"
                                value="${
                                    e.extra_principal || ""
                                }"
                            >

                        </label>


                        <div class="calc">

                            Fixed EMI counted:
                            <b>
                                ${M(
                                    b.scheduled_emi
                                )}
                            </b>

                        </div>

                    </div>

                `;

            }).join("");
    }


    $("pm").onchange =
        renderPaymentPeople;


    renderPaymentPeople();
}


async function savePayment() {

    const m =
        +$("pm").value;


    if (!m) {

        toast("Please select EMI month");

        return;
    }


    for (const b of bs) {

        const extra =
            +$("x" + b.id).value || 0;


        const old =
            pay(m, b.id);


        const v = {

            loan_id:
                loan.id,

            borrower_id:
                b.id,

            month_no:
                m,

            payment_date:
                new Date().toISOString()
                    .slice(0, 10),

            /*
               Fixed EMI is not manually entered.
               It is calculated from borrower settings.
            */

            emi_paid:
                +b.scheduled_emi || 0,

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

            toast(q.error.message);

            return;
        }
    }


    close();

    toast(
        existingPaymentMessage(m)
    );

    load();
}


function existingPaymentMessage(m) {

    return (
        "Payment saved for " +
        monthLabel(m)
    );
}


/* =========================================================
   PAYMENT HISTORY
   ========================================================= */

function history() {

    if (!loan) return;


    let rows = "";


    for (
        let m = 1;
        m <= loan.tenure_months;
        m++
    ) {

        for (const b of bs) {

            const e =
                pay(m, b.id);


            if (
                !e.emi_paid &&
                !e.extra_principal
            ) continue;


            rows += `

                <tr>

                    <td>
                        ${monthLabel(m)}
                    </td>

                    <td>
                        ${esc(b.name)}
                    </td>

                    <td>
                        ${M(
                            b.scheduled_emi
                        )}
                    </td>

                    <td>
                        ${M(
                            e.extra_principal
                        )}
                    </td>

                </tr>

            `;
        }
    }


    modal(`

        <h2>
            Payment History
        </h2>


        ${
            rows
                ? `
                    <div class="table">

                        <table>

                            <tr>

                                <th>
                                    Month
                                </th>

                                <th>
                                    Person
                                </th>

                                <th>
                                    Fixed EMI
                                </th>

                                <th>
                                    Extra
                                </th>

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


/* =========================================================
   AUTH STATE
   ========================================================= */

if (db) {

    db.auth.onAuthStateChange(
        () =>
            setTimeout(
                load,
                0
            )
    );

    load();

} else {

    dashboard();

}


/* =========================================================
   SERVICE WORKER
   ========================================================= */

if ("serviceWorker" in navigator) {

    navigator.serviceWorker.register(
        "./sw.js"
    );

}


/* =========================================================
   START
   ========================================================= */

nav("dashboard");
