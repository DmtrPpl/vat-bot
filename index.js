const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const { OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, PORT = 3000 } = process.env;

if (!OPENAI_API_KEY || !TELEGRAM_BOT_TOKEN) {
  console.error("❌ Missing OPENAI_API_KEY or TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
async function tg(method, body) {
  return axios.post(`${TG_API}/${method}`, body);
}

// =============== STATE ===============
const store = new Map(); // chatId -> { entries: [], settings: { currency, vatRate } }

function getState(chatId) {
  if (!store.has(chatId)) {
    store.set(chatId, {
      entries: [],
      settings: { currency: "EUR", vatRate: 20 },
    });
  }
  return store.get(chatId);
}

// =============== HELPERS ===============
function toISO(dateLike) {
  if (typeof dateLike === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateLike))
    return dateLike;
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function monthOf(dateStr) {
  return dateStr?.slice(0, 7);
}
function yearOf(dateStr) {
  return dateStr?.slice(0, 4);
}
function detectExplicitDate(text) {
  if (!text) return null;
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function computeTriplet(amount, amountType, vatRate, vatApplicable) {
  const A = Number(amount) || 0;
  const r = vatApplicable ? vatRate / 100 : 0;
  if (r <= 0) return { net: +A.toFixed(2), vat: 0, gross: +A.toFixed(2) };

  if (amountType === "net") {
    const vat = +(A * r).toFixed(2);
    return { net: +A.toFixed(2), vat, gross: +(A + vat).toFixed(2) };
  }
  const net = +(A / (1 + r)).toFixed(2);
  return { net, vat: +(A - net).toFixed(2), gross: +A.toFixed(2) };
}

function quickLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([+-])\s*([\d\s.,]+)\s*([a-zA-Z]{3})?/);
      if (!m) return null;
      const type = m[1] === "+" ? "income" : "expense";
      const amount = parseFloat(
        (m[2] || "").replace(/\s+/g, "").replace(",", ".")
      );
      if (!isFinite(amount)) return null;
      const currency = (m[3] || "").toUpperCase() || null;
      const rest = line.slice(m[0].length).trim();
      return { type, amount, currency, rest, raw: line };
    })
    .filter(Boolean);
}

// =============== AI PROMPT ===============
const systemPrompt = `
Ти — помічник з обліку ПДВ для ФОП.
На вхід дається короткий рядок у стилі "+1000 eur сайт" або "-200 інтернет без ПДВ".
Відповідай лише JSON:
{
  "type": "income"|"expense",
  "amount_type": "net"|"gross"|"unknown",
  "vat_applicable": boolean,
  "category": "sales|services|hardware|software|rent|transport|internet|tax|other",
  "description": "коротко",
  "date": "YYYY-MM-DD"
}
`.trim();

// =============== AI ENRICH ===============
async function enrichLineWithAI(line, defaults) {
  const saidWithVAT = /з\s*пд[вв]/i.test(line.raw + " " + line.rest);
  const saidWithoutVAT = /без\s*пд[вв]/i.test(line.raw + " " + line.rest);

  const prompt = `Рядок: ${line.raw}. Валюта: ${defaults.currency}, ставка ПДВ: ${defaults.vatRate}%`;
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 20000,
    }
  );

  let data = {};
  try {
    data = JSON.parse(r.data.choices?.[0]?.message?.content || "{}");
  } catch {}

  let amount_type = data.amount_type || "unknown";
  let vat_applicable =
    typeof data.vat_applicable === "boolean" ? data.vat_applicable : null;

  if (saidWithVAT) {
    vat_applicable = true;
    amount_type = "gross";
  }
  if (saidWithoutVAT) {
    vat_applicable = false;
    amount_type = "net";
  }

  if (line.type === "income") {
    if (vat_applicable === null) vat_applicable = true;
    if (amount_type === "unknown") amount_type = "gross";
  } else {
    if (vat_applicable === null) vat_applicable = true;
    if (amount_type === "unknown") amount_type = vat_applicable ? "gross" : "net";
  }

  const vat_rate = vat_applicable ? defaults.vatRate : 0;
  const category = data.category || "other";
  const description = data.description || line.rest || "";
  const explicit = detectExplicitDate(line.raw) || detectExplicitDate(line.rest);
  const date = explicit ? toISO(explicit) : toISO();
  const currency = (line.currency || defaults.currency).toUpperCase();

  const { net, vat, gross } = computeTriplet(
    line.amount,
    amount_type,
    vat_rate,
    vat_applicable
  );

  const type = line.type;
  const vat_collected = type === "income" ? vat : 0;
  const vat_deductible = type === "expense" && vat_applicable ? vat : 0;

  return {
    type,
    category,
    description,
    date,
    currency,
    net,
    vat,
    gross,
    vat_collected,
    vat_deductible,
  };
}

// =============== AGGREGATES ===============
function totals(entries) {
  let incGross = 0,
    expGross = 0,
    incVAT = 0,
    expVAT = 0;
  entries.forEach((e) => {
    if (e.type === "income") {
      incGross += e.gross;
      incVAT += e.vat_collected;
    } else {
      expGross += e.gross;
      expVAT += e.vat_deductible;
    }
  });
  const profitGross = +(incGross - expGross).toFixed(2);
  const vatDue = +(incVAT - expVAT).toFixed(2);
  const netAfterVAT = +(profitGross - vatDue).toFixed(2);
  return { incGross, expGross, incVAT, expVAT, profitGross, vatDue, netAfterVAT };
}
function vatTotalsMonth(entries, yyyymm) {
  return totals(entries.filter((e) => monthOf(e.date) === yyyymm));
}
function vatTotalsYear(entries, yyyy) {
  return totals(entries.filter((e) => yearOf(e.date) === yyyy));
}

// =============== ROUTES ===============
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);
    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();
    const state = getState(chatId);

    if (text === "/start") {
      await tg("sendMessage", {
        chat_id: chatId,
        parse_mode: "Markdown",
        text: `👋 Привіт! Я *ПДВ-бот*.

Вводь короткі записи:
• Доходи: \`+1000 з ПДВ\`
• Витрати: \`-200 інтернет без ПДВ\`

Команди:
/balance — Загальні дані доходу
/vatmonth [YYYY-MM] — Підсумок ПДВ за поточний або вказаний місяць
/vatyear [YYYY] — Підсумок ПДВ за поточний або вказаний рік
/reset — Очистити всі збережені дані`,
      });
      return res.sendStatus(200);
    }

    if (text === "/reset") {
      state.entries = [];
      await tg("sendMessage", { chat_id: chatId, text: "✅ Дані очищено" });
      return res.sendStatus(200);
    }

    if (text.startsWith("/balance")) {
      const now = new Date();
      const yyyymm = `${now.getFullYear()}-${String(
        now.getMonth() + 1
      ).padStart(2, "0")}`;
      const yyyy = String(now.getFullYear());
      const M = vatTotalsMonth(state.entries, yyyymm);
      const Y = vatTotalsYear(state.entries, yyyy);

      const msg = `
📊 *Місяць ${yyyymm}*
— Оборот: доходи ${M.incGross.toFixed(2)} − витрати ${M.expGross.toFixed(2)} = *${M.profitGross.toFixed(2)}*
— ПДВ: зібрано ${M.incVAT.toFixed(2)} − сплачено ${M.expVAT.toFixed(2)} = *${M.vatDue.toFixed(2)}*
— Чистий після ПДВ: *${M.netAfterVAT.toFixed(2)}*

📊 *Рік ${yyyy}*
— Оборот: доходи ${Y.incGross.toFixed(2)} − витрати ${Y.expGross.toFixed(2)} = *${Y.profitGross.toFixed(2)}*
— ПДВ: зібрано ${Y.incVAT.toFixed(2)} − сплачено ${Y.expVAT.toFixed(2)} = *${Y.vatDue.toFixed(2)}*
— Чистий після ПДВ: *${Y.netAfterVAT.toFixed(2)}*
`.trim();
      await tg("sendMessage", { chat_id: chatId, text: msg, parse_mode: "Markdown" });
      return res.sendStatus(200);
    }

    if (text.startsWith("/vatmonth")) {
      const m = text.match(/^\/vatmonth(?:\s+(\d{4}-\d{2}))?$/i);
      let yyyymm;
      if (m && m[1]) {
        yyyymm = m[1];
      } else {
        const now = new Date();
        yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      }
      const M = vatTotalsMonth(state.entries, yyyymm);
      await tg("sendMessage", {
        chat_id: chatId,
        parse_mode: "Markdown",
        text: `⚖️ *ПДВ за ${yyyymm}:* *${M.vatDue.toFixed(2)}*`,
      });
      return res.sendStatus(200);
    }

    if (text.startsWith("/vatyear")) {
      const m = text.match(/^\/vatyear(?:\s+(\d{4}))?$/i);
      let yyyy;
      if (m && m[1]) {
        yyyy = m[1];
      } else {
        const now = new Date();
        yyyy = String(now.getFullYear());
      }
      const Y = vatTotalsYear(state.entries, yyyy);
      await tg("sendMessage", {
        chat_id: chatId,
        parse_mode: "Markdown",
        text: `⚖️ *ПДВ за ${yyyy} рік:* *${Y.vatDue.toFixed(2)}*`,
      });
      return res.sendStatus(200);
    }

    const lines = quickLines(text);
    if (lines.length === 0) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Формат: `+1000 eur з ПДВ` або `-200 інтернет без ПДВ`",
        parse_mode: "Markdown",
      });
      return res.sendStatus(200);
    }

    const added = [];
    for (const line of lines) {
      const entry = await enrichLineWithAI(line, state.settings);
      state.entries.push(entry);
      added.push(entry);
    }

    const now = new Date();
    const yyyymm = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`;
    const yyyy = String(now.getFullYear());
    const M = vatTotalsMonth(state.entries, yyyymm);
    const Y = vatTotalsYear(state.entries, yyyy);

    const out = ["✅ *Додано записи:*"];
    out.push("");
    added.forEach((e) => {
      const icon = e.type === "income" ? "🟢 Дохід" : "🔴 Витрата";
      out.push(
        [
          `${icon}   •   📅 ${e.date}`,
          `💰 Сума: ${e.gross.toFixed(2)} ${e.currency}`,
          `⚖️ ПДВ: ${e.vat.toFixed(2)}`,
          `📁 Категорія: ${e.category}`,
          `✍️ Опис: ${e.description || "—"}`,
          ``
        ].join("\n")
      );
    });
    out.push(
      [
        `📊 *Місяць ${yyyymm}*`,
        `— Оборот: доходи ${M.incGross.toFixed(2)} − витрати ${M.expGross.toFixed(2)} = *${M.profitGross.toFixed(2)}*`,
        `— ПДВ: зібрано ${M.incVAT.toFixed(2)} − сплачено ${M.expVAT.toFixed(2)} = *${M.vatDue.toFixed(2)}*`,
        `— Чистий після ПДВ: *${M.netAfterVAT.toFixed(2)}*`,
        ``,
        `📊 *Рік ${yyyy}*`,
        `— Оборот: доходи ${Y.incGross.toFixed(2)} − витрати ${Y.expGross.toFixed(2)} = *${Y.profitGross.toFixed(2)}*`,
        `— ПДВ: зібрано ${Y.incVAT.toFixed(2)} − сплачено ${Y.expVAT.toFixed(2)} = *${Y.vatDue.toFixed(2)}*`,
        `— Чистий після ПДВ: *${Y.netAfterVAT.toFixed(2)}*`,
      ].join("\n")
    );

    await tg("sendMessage", {
      chat_id: chatId,
      text: out.join("\n"),
      parse_mode: "Markdown",
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log("🚀 VAT bot running on port " + PORT));
