import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPPORT_CHAT_ID = Number(process.env.SUPPORT_CHAT_ID); // -100 开头

const API = `https://api.telegram.org/bot${TOKEN}`;

// 内存映射（重启会丢失，可以以后改成数据库）
const customerToTopic = new Map();
const topicToCustomer = new Map();

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL }
    });
    console.log("Webhook 已设置：", res.data);
  } catch (e) {
    console.error("Webhook 设置失败：", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== 日志函数 =====================
function logMessage(prefix, msg) {
  console.log(
    `${prefix} chatId=${msg.chat.id} type=${msg.chat.type} thread=${msg.message_thread_id || "-"} from=${msg.from.id} text=${msg.text || "[非文本]"}`
  );
}

// ===================== 创建话题函数 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;

  // 有旧话题直接用
  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const username = customer.username ? `@${customer.username}` : "无";
  const name = `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "无";
  const title = `客户 #${customerId}（${username}）`;

  console.log("🧵 创建话题：", title);

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: SUPPORT_CHAT_ID,
    name: title
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic 未返回 message_thread_id");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);

  return topicId;
}

// ===================== 主 Webhook =====================
app.post("/", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  logMessage("收到消息：", msg);

  const chatType = msg.chat.type;

  // =============== 情况 1：客户私聊机器人 ===============
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      const topicId = await getOrCreateTopic(customer);

      // 内容描述
      let content = msg.text || "";
      if (!content) {
        if (msg.photo) content = "[图片]";
        else if (msg.document) content = "[文件]";
        else content = "[非文本消息]";
      }

      const username = customer.username ? `@${customer.username}` : "无";
      const fullName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "无";

      const header = 
        `📩 客户来消息\n` +
        `客户ID: ${customerId}\n用户名: ${username}\n昵称: ${fullName}\n`;

      // 发到话题
      await axios.post(`${API}/sendMessage`, {
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: topicId,
        text: `${header}内容：\n${content}`
      });

      // 有图片则继续发
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: SUPPORT_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
          caption: `来自客户（ID ${customerId}）的图片`
        });
      }
    } catch (e) {
      console.error("处理客户消息失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // =============== 情况 2：客服在群里回复 ===============
  if (chatType === "supergroup") {

    // 只处理我们的客服群
    if (msg.chat.id !== SUPPORT_CHAT_ID) return res.sendStatus(200);

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200);

    if (msg.from.is_bot) return res.sendStatus(200);

    // 找对应的客户
    let customerId = topicToCustomer.get(topicId);
    if (!customerId) return res.sendStatus(200);

    try {
      // 图片
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || ""
        });
        return res.sendStatus(200);
      }

      // 文本
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text
        });
      }

    } catch (e) {
      console.error("客服回复失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ===================== 启动服务器 =====================
app.listen(Number(process.env.PORT) || 3000, () => {
  console.log("🚀 Bot 已启动");
});
