import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;

const API = `https://api.telegram.org/bot${TOKEN}`;

console.log("🔧 BOT_TOKEN =", TOKEN);
console.log("🔧 GROUP_CHAT_ID =", GROUP_CHAT_ID);
console.log("🔧 WEBHOOK_URL =", WEBHOOK_URL);

// ===================== 内存映射 =====================
const customerToTopic = new Map(); // 客户 -> 话题
const topicToCustomer = new Map(); // 话题 -> 客户

// ===================== 检查并设置 Webhook =====================
async function ensureWebhook() {
  try {
    const info = await axios.get(`${API}/getWebhookInfo`);
    const currentUrl = info.data?.result?.url || "";

    if (currentUrl === WEBHOOK_URL) {
      console.log("✅ Webhook 已正确设置:", currentUrl);
      return;
    }

    if (currentUrl) {
      console.log("⚠️ 发现旧 Webhook，正在删除:", currentUrl);
      await axios.get(`${API}/deleteWebhook`);
    }

    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL },
    });

    console.log("✅ Webhook 已设置成功：", res.data);
  } catch (err) {
    console.error("❌ 设置 Webhook 失败：", err.response?.data || err.message);
  }
}
ensureWebhook();

// ===================== 日志 =====================
function logMessage(prefix, msg) {
  console.log(
    `${prefix} chatId=${msg.chat.id} type=${msg.chat.type} thread=${
      msg.message_thread_id ?? "-"
    } from=${msg.from.id} text=${msg.text || "[非文本]"}`
  );
}

// ===================== 创建话题 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;

  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const title = `客户 ${customerId}`;
  console.log("🧵 创建话题：", title);

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: title,
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("❌ createForumTopic 未返回 message_thread_id");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);

  console.log(`✅ 映射建立：客户 ${customerId} ↔ 话题 ${topicId}`);
  return topicId;
}

// ===================== Telegram Webhook =====================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  logMessage("📩 收到消息：", msg);
  const chatType = msg.chat.type;

  // =============== 客户私聊机器人 ===============
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      // 自动欢迎（只发一次）
      if (!customerToTopic.has(customerId)) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: `¡Hola cariño! Soy Steven071_bot 🤖\nEstoy aquí para ayudarte, ¿en qué necesitas apoyo?`,
        });
      }

      const topicId = await getOrCreateTopic(customer);
      let content = msg.text || "";
      if (!content) {
        if (msg.photo) content = "[Imagen]";
        else if (msg.document) content = "[Documento]";
        else content = "[Mensaje no textual]";
      }

      await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: `💌 Mensaje del cliente\nID: ${customerId}\nUsuario: @${
          customer.username || "no"
        }\nNombre: ${customer.first_name || "?"}\nContenido: ${content}`,
      });

      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
        });
      }
    } catch (err) {
      console.error("❌ 处理客户消息失败：", err.response?.data || err.message);
    }

    return res.sendStatus(200);
  }

  // =============== 客服群内回复 ===============
  if (chatType === "supergroup") {
    if (String(msg.chat.id) !== GROUP_CHAT_ID) {
      return res.sendStatus(200);
    }

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200);
    if (msg.from.is_bot) return res.sendStatus(200);

    const customerId = topicToCustomer.get(topicId);
    if (!customerId) {
      console.log("⚠️ 找不到对应客户 topicId =", topicId);
      return res.sendStatus(200);
    }

    try {
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text,
        });
        console.log(`✅ 群消息已转发给客户 ${customerId}`);
      }

      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || "",
        });
        console.log(`✅ 图片已转发给客户 ${customerId}`);
      }
    } catch (err) {
      console.error("❌ 客服回复失败：", err.response?.data || err.message);
    }

    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

// ===================== 根路径健康检查 =====================
app.get("/", (req, res) => {
  res.send("✅ Bot 运行中 - Telegram Webhook /webhook 已配置");
});

// ===================== 启动服务器 =====================
app.listen(PORT, () => {
  console.log(`🚀 Bot 已启动，端口 ${PORT}`);
});
