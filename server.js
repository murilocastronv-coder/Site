// Servidor de pagamento (Stripe Checkout) para o site de venda do servidor MMORPG.
// As chaves do Stripe ficam SOMENTE nas variáveis de ambiente do Render:
//   STRIPE_SECRET_KEY      -> sk_live_...
//   STRIPE_WEBHOOK_SECRET  -> whsec_... (opcional)
//   SITE_URL               -> URL principal do site (ex.: https://servidor-mmorpg-pagamento.onrender.com)
//   ALLOWED_ORIGINS        -> outras URLs do site que podem chamar a API, separadas por vírgula
const path = require("path");
const express = require("express");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
const app = express();
const PORT = process.env.PORT || 3000;

// Preços definidos SÓ no servidor (o cliente não consegue alterar o valor).
const PLANS = {
  servidor: { name: "Plano Servidor MMORPG", amount: 40000 },          // R$ 400,00
  completo: { name: "Servidor MMORPG + Instalação", amount: 50000 },   // R$ 400 + R$ 100
};

const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const ALLOWED = [SITE_URL]
  .concat((process.env.ALLOWED_ORIGINS || "").split(","))
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

function siteBase(req) {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  return ALLOWED.includes(origin) ? origin : SITE_URL || `${req.protocol}://${req.get("host")}`;
}

// CORS: qualquer domínio do site pode chamar a API (os preços ficam fixos no servidor).
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Webhook do Stripe (registra os pagamentos nos logs do Render).
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.sendStatus(200);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch (err) {
    console.error("Webhook inválido:", err.message);
    return res.status(400).send("assinatura inválida");
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    console.log(
      `💰 PAGAMENTO RECEBIDO: ${s.metadata && s.metadata.plan} | R$ ${(s.amount_total / 100).toFixed(2)} | ` +
        `${(s.customer_details && s.customer_details.email) || "-"} | ${(s.customer_details && s.customer_details.phone) || "-"}`
    );
  }
  res.sendStatus(200);
});

app.use(express.json());

// Cria a sessão de pagamento e devolve a URL do checkout do Stripe.
app.post("/api/checkout", async (req, res) => {
  const planKey = req.body && req.body.plan;
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: "Plano inválido" });
  try {
    const base = siteBase(req);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "brl", unit_amount: plan.amount, product_data: { name: plan.name } },
        },
      ],
      phone_number_collection: { enabled: true },
      metadata: { plan: planKey },
      success_url: `${base}/sucesso.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#planos`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erro ao criar checkout:", err.message);
    res.status(500).json({ error: "Não foi possível iniciar o pagamento. Tente novamente ou chame no WhatsApp." });
  }
});

// Confirma o pagamento na página de sucesso.
app.get("/api/session/:id", async (req, res) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(req.params.id);
    const plan = PLANS[s.metadata && s.metadata.plan];
    res.json({
      paid: s.payment_status === "paid",
      plan: plan ? plan.name : "",
      amount: s.amount_total / 100,
      ref: s.id.slice(-8).toUpperCase(),
    });
  } catch (err) {
    res.status(404).json({ paid: false });
  }
});

// Páginas do site.
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, f));
app.get("/", page("index.html"));
app.get("/index.html", page("index.html"));
app.get("/sucesso.html", page("sucesso.html"));
app.get("/config.js", page("config.js"));
app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => console.log("Site rodando na porta " + PORT));
