const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const axios = require("axios");
const mysql = require("mysql2/promise");
const path = require("path");
const app = express();
const port = 4003;
require("dotenv").config();

// LINE Bot configuration
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MySQL Pool
const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB,
  port: process.env.DB_PORT || "3306",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Root route
app.get("/", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  var message = "Client Management API\n",
    version = "NodeJS " + process.versions.node + "\n",
    response = [message, version].join("\n");
  res.end(response);
});

// === Helper Functions ===
const LEAD_STATUS_LABELS = {
  new: "ลูกค้าใหม่",
  qualified: "Qualified",
  discussion: "Discussion",
  negotiation: "คุยแล้วกำลังตัดสินใจ",
  won: "ซื้อแล้ว",
  lost: "ไม่ซื้อ",
};

const LEAD_STATUS_IDS = {
  new: 1,
  qualified: 2,
  discussion: 3,
  negotiation: 4,
  won: 5,
  lost: 6,
};

const STATUS_UPDATE_BUTTONS = [
  { key: "negotiation", label: "คุยแล้วกำลังตัดสินใจ" },
  { key: "won", label: "ซื้อแล้ว" },
  { key: "lost", label: "ไม่ซื้อ" },
];

const pendingLostReasons = new Map();

function getLeadStatusLabelById(statusId) {
  const entries = Object.entries(LEAD_STATUS_IDS);
  const statusKey = entries.find(([, id]) => id === statusId)?.[0];
  return LEAD_STATUS_LABELS[statusKey] || "ลูกค้าใหม่";
}

async function getRiseUserDisplayName(riseUserId) {
  if (!riseUserId) {
    return "Unknown";
  }

  const [rows] = await dbPool.query(
    "SELECT first_name, last_name FROM rise_users WHERE id = ? AND deleted = 0",
    [riseUserId]
  );

  if (rows.length === 0) {
    return "Unknown";
  }

  const firstName = rows[0].first_name || "";
  const lastName = rows[0].last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || "Unknown";
}

async function getOwnerDisplayName(riseUserId, sourceInfo) {
  try {
    if (!riseUserId) {
      return "Unknown";
    }

    const [rows] = await dbPool.query(
      "SELECT line_user_id FROM rise_users WHERE id = ? AND deleted = 0",
      [riseUserId]
    );

    if (rows.length === 0 || !rows[0].line_user_id) {
      return await getRiseUserDisplayName(riseUserId);
    }

    const lineUserId = rows[0].line_user_id;
    const profile =
      sourceInfo?.type === "group" && sourceInfo.groupId
        ? await getLineGroupMemberProfile(sourceInfo.groupId, lineUserId)
        : await getLineUserProfile(lineUserId);

    return profile.displayName || (await getRiseUserDisplayName(riseUserId));
  } catch (error) {
    console.error("Error getting owner display name:", error);
    return await getRiseUserDisplayName(riseUserId);
  }
}

function parseAddressAndReason(address) {
  if (!address) {
    return { address: "", reason: "" };
  }

  const marker = " reason: ";
  const markerIndex = address.indexOf(marker);
  if (markerIndex === -1) {
    return { address: address, reason: "" };
  }

  return {
    address: address.slice(0, markerIndex).trim(),
    reason: address.slice(markerIndex + marker.length).trim(),
  };
}

function buildField(label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      {
        type: "text",
        text: label,
        size: "sm",
        color: "#555555",
        flex: 3,
      },
      {
        type: "text",
        text: value || "-",
        size: "sm",
        color: "#111111",
        flex: 7,
        wrap: true,
      },
    ],
  };
}

function buildClientFlexMessage({
  clientData,
  clientId,
  userProfile,
  sourceInfo,
  statusLabel,
}) {
  const sourceText =
    sourceInfo?.type === "group"
      ? `จากกลุ่ม: ${sourceInfo.groupName || "Unknown Group"}`
      : "";

  const fields = [
    buildField("ชื่อ", clientData.name),
    buildField("เบอร์โทร", clientData.phone),
    buildField("รายละเอียด", clientData.address || "ไม่มี"),
    buildField("Client ID", String(clientId)),
    buildField("บันทึกโดย", userProfile.displayName),
    buildField("ผู้รับผิดชอบ", userProfile.displayName),
  ];

  if (sourceText) {
    fields.push(buildField("จากกลุ่ม", sourceInfo.groupName || "Unknown Group"));
  }

  fields.push(buildField("สถานะ", statusLabel));

  return {
    type: "flex",
    altText: "บันทึกลูกค้าใหม่สำเร็จ",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "บันทึกลูกค้าใหม่สำเร็จ",
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: fields,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "ติดต่อ",
              data: `action=assign&clientId=${clientId}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "อัพเดท",
              data: `action=update&clientId=${clientId}`,
            },
          },
        ],
        flex: 0,
      },
    },
  };
}

function buildStatusUpdateFlexMessage(clientData, ownerName) {
  const statusLabel = getLeadStatusLabelById(clientData.lead_status_id);

  return {
    type: "flex",
    altText: "อัพเดทสถานะลูกค้า",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "อัพเดทสถานะลูกค้า",
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: [
              buildField("ชื่อ", clientData.company_name),
              buildField("เบอร์โทร", clientData.phone),
              buildField("รายละเอียด", clientData.address || "ไม่มี"),
              buildField("ผู้รับผิดชอบ", ownerName),
              buildField("สถานะ", statusLabel),
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: STATUS_UPDATE_BUTTONS.map((button) => ({
          type: "button",
          style: "secondary",
          action: {
            type: "postback",
            label: button.label,
            data: `action=setStatus&clientId=${clientData.id}&status=${button.key}`,
          },
        })),
        flex: 0,
      },
    },
  };
}

function buildStatusUpdatedFlexMessage(clientData, ownerName) {
  const statusLabel = getLeadStatusLabelById(clientData.lead_status_id);
  const parsed = parseAddressAndReason(clientData.address || "");

  return {
    type: "flex",
    altText: "อัพเดทสถานะลูกค้าแล้ว",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "อัพเดทสถานะลูกค้าแล้ว",
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: [
              buildField("ชื่อ", clientData.company_name),
              buildField("เบอร์โทร", clientData.phone),
              buildField("รายละเอียด", parsed.address || "ไม่มี"),
              ...(parsed.reason ? [buildField("เหตุผล", parsed.reason)] : []),
              buildField("Client ID", String(clientData.id)),
              buildField("ผู้รับผิดชอบ", ownerName),
              buildField("สถานะ", statusLabel),
            ],
          },
        ],
      },
    },
  };
}

function buildAssignedOwnerFlexMessage({ clientData, userProfile, sourceInfo }) {
  const statusLabel = getLeadStatusLabelById(clientData.lead_status_id);
  const parsed = parseAddressAndReason(clientData.address || "");
  const fields = [
    buildField("ชื่อ", clientData.company_name),
    buildField("เบอร์โทร", clientData.phone),
    buildField("รายละเอียด", parsed.address || "ไม่มี"),
    ...(parsed.reason ? [buildField("เหตุผล", parsed.reason)] : []),
    buildField("Client ID", String(clientData.id)),
    buildField("ผู้รับผิดชอบ", userProfile.displayName),
    buildField("สถานะ", statusLabel),
  ];

  if (sourceInfo?.type === "group") {
    fields.push(buildField("จากกลุ่ม", sourceInfo.groupName || "Unknown Group"));
  }

  fields.push(
    buildField(
      "หมายเหตุ",
      "กรุณาติดต่อลูกค้า และอัพเดทสถานะลูกค้า"
    )
  );

  return {
    type: "flex",
    altText: "เปลี่ยนผู้รับผิดชอบแล้ว",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "เปลี่ยนผู้รับผิดชอบแล้ว",
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: fields,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "อัพเดท",
              data: `action=update&clientId=${clientData.id}`,
            },
          },
        ],
        flex: 0,
      },
    },
  };
}

// Get LINE user profile
async function getLineUserProfile(userId) {
  try {
    const response = await axios.get(
      `https://api.line.me/v2/bot/profile/${userId}`,
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error getting LINE user profile:", error);
    return { displayName: "Unknown User", userId: userId };
  }
}

// Get LINE group member profile
async function getLineGroupMemberProfile(groupId, userId) {
  try {
    const response = await axios.get(
      `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error getting LINE group member profile:", error);
    // Fallback to regular user profile
    return await getLineUserProfile(userId);
  }
}

// Get Rise User ID from LINE User ID
async function getRiseUserIdFromLineId(lineUserId) {
  try {
    // Check user_mappings table
    const [mappings] = await dbPool.query(
      "SELECT rise_user_id FROM user_mappings WHERE line_user_id = ?",
      [lineUserId]
    );

    if (mappings.length > 0 && mappings[0].rise_user_id) {
      return mappings[0].rise_user_id;
    }

    // Return default user if not found
    return 1;
  } catch (err) {
    console.error("Error getting Rise user ID:", err.message);
    return 1; // Default to admin user
  }
}

// Parse client input
function parseClientInput(text) {
  // Remove #ลูกค้า command if present
  const cleanText = text.replace("#ลูกค้า", "").trim();

  // Find phone number pattern (exactly 10 digits, with or without separators)
  const phoneRegex = /(\d{3}[-\s]?\d{3}[-\s]?\d{4}|\d{10})/g;
  const phoneMatches = cleanText.match(phoneRegex);

  let name = "";
  let phone = "";
  let address = "";

  if (phoneMatches && phoneMatches.length > 0) {
    // Find the first valid 10-digit phone number
    let validPhone = null;
    let phoneStartIndex = -1;

    for (const match of phoneMatches) {
      const digitsOnly = match.replace(/[-\s]/g, "");
      if (digitsOnly.length === 10) {
        validPhone = digitsOnly;
        phoneStartIndex = cleanText.indexOf(match);
        break;
      }
    }

    if (validPhone && phoneStartIndex !== -1) {
      phone = validPhone;

      // Everything before the phone number is the name (trim extra spaces)
      name = cleanText
        .substring(0, phoneStartIndex)
        .trim()
        .replace(/\s+/g, " ");

      // Everything after the phone number is the address
      const phoneMatch = phoneMatches[0];
      const phoneEndIndex = phoneStartIndex + phoneMatch.length;
      address = cleanText.substring(phoneEndIndex).trim();
    }
  }

  // If no valid phone found, try fallback parsing
  if (!phone) {
    // Look for any sequence of digits that might be a phone
    const digitSequences = cleanText.match(/\d+/g);
    if (digitSequences) {
      for (const sequence of digitSequences) {
        if (sequence.length === 10) {
          phone = sequence;
          const phoneIndex = cleanText.indexOf(sequence);
          name = cleanText.substring(0, phoneIndex).trim().replace(/\s+/g, " ");
          address = cleanText.substring(phoneIndex + sequence.length).trim();
          break;
        }
      }
    }
  }

  // If still no phone found, treat entire text as name
  if (!phone) {
    name = cleanText.replace(/\s+/g, " ");
  }

  if (!name) {
    throw new Error("กรุณาระบุชื่อลูกค้า");
  }

  return {
    name: name,
    phone: phone,
    address: address || "",
  };
}

// Process client data and store to rise_clients table
async function processClientData(userId, clientData, sourceInfo = {}) {
  try {
    const riseUserId = await getRiseUserIdFromLineId(userId);
    let userProfile;

    // Get user profile based on source type
    if (sourceInfo.type === "group") {
      userProfile = await getLineGroupMemberProfile(sourceInfo.groupId, userId);
    } else {
      userProfile = await getLineUserProfile(userId);
    }

    // Check if client already exists
    const [existingClients] = await dbPool.query(
      "SELECT id, company_name, phone FROM rise_clients WHERE phone = ? AND deleted = 0",
      [clientData.phone]
    );

    // if (existingClients.length > 0) {
    //   const existing = existingClients[0];
    //   return {
    //     success: false,
    //     message: `ลูกค้าซ้ำ!\nชื่อ: ${existing.company_name}\nเบอร์: ${existing.phone}\nID: ${existing.id}`,
    //   };
    // }

    // Insert new client into rise_clients table
    const [result] = await dbPool.query(
      `
      INSERT INTO rise_clients (
        company_name, type, address, created_date, phone, 
        starred_by, group_ids, deleted, is_lead, lead_status_id, 
        owner_id, created_by, sort, lead_source_id, last_lead_status, 
        client_migration_date, stripe_customer_id, stripe_card_ending_digit
      ) VALUES (?, 'person', ?, CURDATE(), ?, '', '', 0, 1, 1, ?, ?, 0, 1, '', CURDATE(), '', 0)
    `,
      [
        clientData.name, // company_name -> คุณกรณี
        clientData.address, // address -> สนใจสินค้าค่ะ ติดต่อกลับด่วน
        clientData.phone, // phone -> 0641989925
        riseUserId, // owner_id
        riseUserId, // created_by
      ]
    );

    const clientId = result.insertId;

    const responseMessage = buildClientFlexMessage({
      clientData,
      clientId,
      userProfile,
      sourceInfo,
      statusLabel: LEAD_STATUS_LABELS.new,
    });

    return {
      success: true,
      message: responseMessage,
      clientId: clientId,
    };
  } catch (error) {
    console.error("Error processing client data:", error);
    return {
      success: false,
      message: `เกิดข้อผิดพลาด: ${error.message}`,
    };
  }
}

// Search clients in rise_clients table
async function searchClients(searchTerm) {
  try {
    const [clients] = await dbPool.query(
      `
      SELECT id, company_name, phone, address, created_date
      FROM rise_clients 
      WHERE deleted = 0 
      AND (company_name LIKE ? OR phone LIKE ? OR address LIKE ?)
      ORDER BY created_date DESC
      LIMIT 20
    `,
      [`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`]
    );

    if (clients.length === 0) {
      return "ไม่พบลูกค้าที่ค้นหา";
    }

    let result = `ผลการค้นหาลูกค้า (${clients.length} รายการ):\n\n`;

    clients.forEach((client, index) => {
      result += `${index + 1}. ${client.company_name}\n`;
      result += `   เบอร์: ${client.phone || "ไม่มี"}\n`;
      result += `   รายละเอียด: ${client.address || "ไม่มี"}\n`;
      result += `   ID: ${client.id}\n`;
      result += `   วันที่สร้าง: ${client.created_date}\n\n`;
    });

    return result;
  } catch (error) {
    console.error("Error searching clients:", error);
    return `เกิดข้อผิดพลาดในการค้นหา: ${error.message}`;
  }
}

// Send LINE reply message
async function sendLineReply(replyToken, message) {
  try {
    const messages = Array.isArray(message) ? message : [message];
    const payloadMessages = messages.map((item) =>
      typeof item === "string" ? { type: "text", text: item } : item
    );
    console.log("LINE reply payload:", {
      replyToken,
      messages: payloadMessages,
    });
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: replyToken,
        messages: payloadMessages,
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error sending LINE reply:", error);
  }
}

// Get group summary
async function getGroupSummary(groupId) {
  try {
    const response = await axios.get(
      `https://api.line.me/v2/bot/group/${groupId}/summary`,
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error getting group summary:", error);
    return { groupName: "Unknown Group" };
  }
}

// === API Routes ===

// Get all clients from rise_clients table
app.get("/api/clients", async (req, res) => {
  try {
    const [clients] = await dbPool.query(`
      SELECT id, company_name, type, phone, address, created_date, 
             is_lead, lead_status_id, owner_id, created_by
      FROM rise_clients
      WHERE deleted = 0
      ORDER BY created_date DESC
      LIMIT 100
    `);
    res.json(clients);
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search clients API
app.get("/api/clients/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const result = await searchClients(q);
    res.json({ result });
  } catch (error) {
    console.error("Error searching clients:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete client (soft delete)
app.delete("/api/clients/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await dbPool.query(
      "UPDATE rise_clients SET deleted = 1 WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    res.json({ success: true, message: "Client deleted successfully" });
  } catch (error) {
    console.error("Error deleting client:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update client
app.put("/api/clients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { company_name, phone, address } = req.body;

    if (!company_name || !phone) {
      return res
        .status(400)
        .json({ error: "Company name and phone are required" });
    }

    // Check for duplicate phone (excluding current client)
    const [existing] = await dbPool.query(
      "SELECT id FROM rise_clients WHERE phone = ? AND id != ? AND deleted = 0",
      [phone, id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "Phone number already exists" });
    }

    const [result] = await dbPool.query(
      "UPDATE rise_clients SET company_name = ?, phone = ?, address = ? WHERE id = ?",
      [company_name, phone, address || "", id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    res.json({ success: true, message: "Client updated successfully" });
  } catch (error) {
    console.error("Error updating client:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for client processing
app.post("/api/test-client", async (req, res) => {
  try {
    const { userId, clientText } = req.body;

    if (!userId || !clientText) {
      return res
        .status(400)
        .json({ error: "userId and clientText are required" });
    }

    const clientData = parseClientInput(clientText);
    const result = await processClientData(userId, clientData);

    res.json(result);
  } catch (error) {
    console.error("Test client error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get client statistics
app.get("/api/clients/stats", async (req, res) => {
  try {
    const [totalClients] = await dbPool.query(
      "SELECT COUNT(*) as total FROM rise_clients WHERE deleted = 0"
    );

    const [todayClients] = await dbPool.query(
      "SELECT COUNT(*) as today FROM rise_clients WHERE deleted = 0 AND created_date = CURDATE()"
    );

    const [thisWeekClients] = await dbPool.query(
      "SELECT COUNT(*) as this_week FROM rise_clients WHERE deleted = 0 AND created_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)"
    );

    const [thisMonthClients] = await dbPool.query(
      "SELECT COUNT(*) as this_month FROM rise_clients WHERE deleted = 0 AND MONTH(created_date) = MONTH(CURDATE()) AND YEAR(created_date) = YEAR(CURDATE())"
    );

    const [leadClients] = await dbPool.query(
      "SELECT COUNT(*) as leads FROM rise_clients WHERE deleted = 0 AND is_lead = 1"
    );

    const [personClients] = await dbPool.query(
      'SELECT COUNT(*) as persons FROM rise_clients WHERE deleted = 0 AND type = "person"'
    );

    const [organizationClients] = await dbPool.query(
      'SELECT COUNT(*) as organizations FROM rise_clients WHERE deleted = 0 AND type = "organization"'
    );

    res.json({
      total: totalClients[0].total,
      today: todayClients[0].today,
      this_week: thisWeekClients[0].this_week,
      this_month: thisMonthClients[0].this_month,
      leads: leadClients[0].leads,
      persons: personClients[0].persons,
      organizations: organizationClients[0].organizations,
    });
  } catch (error) {
    console.error("Error fetching client stats:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get client by ID
app.get("/api/clients/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [clients] = await dbPool.query(
      "SELECT * FROM rise_clients WHERE id = ? AND deleted = 0",
      [id]
    );

    if (clients.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    res.json(clients[0]);
  } catch (error) {
    console.error("Error fetching client:", error);
    res.status(500).json({ error: error.message });
  }
});

// LINE Webhook
app.post("/webhook/line", async (req, res) => {
  try {
    console.log("LINE webhook raw body:", req.body);
    const events = req.body.events;

    for (const event of events) {
      console.log("LINE event:", event);
      const userId = event.source.userId;
      const replyToken = event.replyToken;
      const sourceType = event.source.type; // 'user', 'group', 'room'

      // Determine source information
      let sourceInfo = { type: sourceType };
      if (sourceType === "group") {
        sourceInfo.groupId = event.source.groupId;
        try {
          const groupSummary = await getGroupSummary(event.source.groupId);
          sourceInfo.groupName = groupSummary.groupName;
        } catch (error) {
          sourceInfo.groupName = "Unknown Group";
        }
      } else if (sourceType === "room") {
        sourceInfo.roomId = event.source.roomId;
      }
      console.log("Source info:", sourceInfo);

      if (event.type === "postback") {
        const data = event.postback.data || "";
        const params = new URLSearchParams(data);
        const action = params.get("action");
        const clientId = params.get("clientId");
        console.log("Postback data:", { data, action, clientId });

        if (!action || !clientId) {
          await sendLineReply(replyToken, "ข้อมูลไม่ครบถ้วน");
          continue;
        }

        if (action === "assign") {
          try {
            const riseUserId = await getRiseUserIdFromLineId(userId);
            console.log("Assign owner to rise user:", { clientId, riseUserId });

            const [result] = await dbPool.query(
              "UPDATE rise_clients SET owner_id = ? WHERE id = ? AND deleted = 0",
              [riseUserId, clientId]
            );
            console.log("Assign owner result:", result);

            if (result.affectedRows === 0) {
              await sendLineReply(replyToken, "ไม่พบลูกค้าที่ต้องการอัพเดท");
              continue;
            }

            const userProfile =
              sourceInfo.type === "group"
                ? await getLineGroupMemberProfile(sourceInfo.groupId, userId)
                : await getLineUserProfile(userId);

            const [clients] = await dbPool.query(
              "SELECT id, company_name, phone, address, lead_status_id FROM rise_clients WHERE id = ? AND deleted = 0",
              [clientId]
            );

            if (clients.length === 0) {
              await sendLineReply(replyToken, "ไม่พบลูกค้าที่ต้องการอัพเดท");
              continue;
            }

            const assignMessage = buildAssignedOwnerFlexMessage({
              clientData: clients[0],
              userProfile,
              sourceInfo,
            });
            await sendLineReply(replyToken, assignMessage);
          } catch (error) {
            console.error("Error assigning client owner:", error);
            await sendLineReply(replyToken, "เกิดข้อผิดพลาดในการอัพเดทผู้รับผิดชอบ");
          }
        } else if (action === "update") {
          try {
            const [clients] = await dbPool.query(
              "SELECT id, company_name, phone, address, lead_status_id, owner_id FROM rise_clients WHERE id = ? AND deleted = 0",
              [clientId]
            );
            console.log("Update status fetch client:", clients[0]);

            if (clients.length === 0) {
              await sendLineReply(replyToken, "ไม่พบลูกค้าที่ต้องการอัพเดท");
              continue;
            }

            const ownerName = await getOwnerDisplayName(
              clients[0].owner_id,
              sourceInfo
            );
            const updateMessage = buildStatusUpdateFlexMessage(
              clients[0],
              ownerName
            );
            await sendLineReply(replyToken, updateMessage);
          } catch (error) {
            console.error("Error preparing status update:", error);
            await sendLineReply(replyToken, "เกิดข้อผิดพลาดในการโหลดข้อมูลลูกค้า");
          }
        } else if (action === "setStatus") {
          try {
            const statusKey = params.get("status");
            const leadStatusId = LEAD_STATUS_IDS[statusKey];
            const statusLabel = LEAD_STATUS_LABELS[statusKey];
            console.log("Set status request:", {
              clientId,
              statusKey,
              leadStatusId,
              statusLabel,
            });

            if (!leadStatusId) {
              await sendLineReply(replyToken, "สถานะไม่ถูกต้อง");
              continue;
            }

            if (statusKey === "lost") {
              pendingLostReasons.set(userId, { clientId });
              await sendLineReply(replyToken, "กรุณาระบุเหตุผล");
              continue;
            }

            const [result] = await dbPool.query(
              "UPDATE rise_clients SET lead_status_id = ? WHERE id = ? AND deleted = 0",
              [leadStatusId, clientId]
            );
            console.log("Set status result:", result);

            if (result.affectedRows === 0) {
              await sendLineReply(replyToken, "ไม่พบลูกค้าที่ต้องการอัพเดทสถานะ");
              continue;
            }

            const [clients] = await dbPool.query(
              "SELECT id, company_name, phone, address, lead_status_id, owner_id FROM rise_clients WHERE id = ? AND deleted = 0",
              [clientId]
            );

            if (clients.length === 0) {
              await sendLineReply(
                replyToken,
                `อัพเดทสถานะลูกค้าเป็น: ${statusLabel}`
              );
              continue;
            }

            const ownerName = await getOwnerDisplayName(
              clients[0].owner_id,
              sourceInfo
            );
            const updatedMessage = buildStatusUpdatedFlexMessage(
              clients[0],
              ownerName
            );
            await sendLineReply(replyToken, updatedMessage);
          } catch (error) {
            console.error("Error updating client status:", error);
            await sendLineReply(replyToken, "เกิดข้อผิดพลาดในการอัพเดทสถานะลูกค้า");
          }
        }
      } else if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();
        console.log("Incoming text:", text);

        const pendingLost = pendingLostReasons.get(userId);
        if (pendingLost) {
          try {
            const [clients] = await dbPool.query(
              "SELECT id, company_name, phone, address, lead_status_id, owner_id FROM rise_clients WHERE id = ? AND deleted = 0",
              [pendingLost.clientId]
            );

            if (clients.length === 0) {
              pendingLostReasons.delete(userId);
              await sendLineReply(replyToken, "ไม่พบลูกค้าที่ต้องการอัพเดทสถานะ");
              continue;
            }

            const client = clients[0];
            const reason = text.trim();
            const parsed = parseAddressAndReason(client.address || "");
            const mergedAddress = `${parsed.address} reason: ${reason}`.trim();

            await dbPool.query(
              "UPDATE rise_clients SET lead_status_id = ?, address = ? WHERE id = ? AND deleted = 0",
              [LEAD_STATUS_IDS.lost, mergedAddress, pendingLost.clientId]
            );

            const [updatedClients] = await dbPool.query(
              "SELECT id, company_name, phone, address, lead_status_id, owner_id FROM rise_clients WHERE id = ? AND deleted = 0",
              [pendingLost.clientId]
            );

            pendingLostReasons.delete(userId);

            if (updatedClients.length === 0) {
              await sendLineReply(replyToken, "อัพเดทสถานะเรียบร้อยแล้ว");
              continue;
            }

            const ownerName = await getOwnerDisplayName(
              updatedClients[0].owner_id,
              sourceInfo
            );
            const updatedMessage = buildStatusUpdatedFlexMessage(
              updatedClients[0],
              ownerName
            );
            await sendLineReply(replyToken, updatedMessage);
            continue;
          } catch (error) {
            console.error("Error updating lost reason:", error);
            pendingLostReasons.delete(userId);
            await sendLineReply(replyToken, "เกิดข้อผิดพลาดในการบันทึกเหตุผล");
            continue;
          }
        }

        try {
          // Check if it's a client search command
          if (text.startsWith("#ลูกค้า")) {
            const searchTerm = text.replace("#ลูกค้า", "").trim();

            if (searchTerm) {
              // Search for clients
              const searchResult = await searchClients(searchTerm);
              await sendLineReply(replyToken, searchResult);
            } else {
              await sendLineReply(
                replyToken,
                "กรุณาระบุคำค้นหา\n\nตัวอย่าง:\n• #ลูกค้า คุณกรณี\n• #ลูกค้า 0641989925\n• #ลูกค้า สนใจสินค้า"
              );
            }
          }
          // Check if it's client data input
          else if (
            text.includes("คุณ") ||
            text.match(/^-.*-\d{9,10}/) ||
            text.match(/\d{9,10}/)
          ) {
            // Parse and process client data
            const clientData = parseClientInput(text);
            console.log("Parsed client data:", clientData);
            const result = await processClientData(
              userId,
              clientData,
              sourceInfo
            );
            console.log("Process client result:", result);
            await sendLineReply(replyToken, result.message);
          }
          // Help command
          else if (
            text.toLowerCase() === "help" ||
            text === "ช่วยเหลือ" ||
            text === "คำสั่ง"
          ) {
            const sourceText =
              sourceType === "group"
                ? "\n\nใช้งานได้ในกลุ่มและแชทส่วนตัว"
                : "";
            const helpMessage = `คำสั่งที่ใช้ได้:

บันทึกลูกค้าใหม่:
• คุณกรณี 0641989925 สนใจสินค้าค่ะ ติดต่อกลับด่วน
• คุณกรณี 0641989925
• -คุณกรณี-0641989925-สนใจสินค้าค่ะ ติดต่อกลับด่วน

ค้นหาลูกค้า:
• #ลูกค้า คุณกรณี
• #ลูกค้า 0641989925
• #ลูกค้า สนใจสินค้า

ช่วยเหลือ:
• help, ช่วยเหลือ หรือ คำสั่ง

สถิติ:
• สถิติ หรือ stats${sourceText}`;

            await sendLineReply(replyToken, helpMessage);
          }
          // Stats command
          else if (text === "สถิติ" || text.toLowerCase() === "stats") {
            try {
              const [totalClients] = await dbPool.query(
                "SELECT COUNT(*) as total FROM rise_clients WHERE deleted = 0"
              );

              const [todayClients] = await dbPool.query(
                "SELECT COUNT(*) as today FROM rise_clients WHERE deleted = 0 AND created_date = CURDATE()"
              );

              const [thisWeekClients] = await dbPool.query(
                "SELECT COUNT(*) as this_week FROM rise_clients WHERE deleted = 0 AND created_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)"
              );

              const [thisMonthClients] = await dbPool.query(
                "SELECT COUNT(*) as this_month FROM rise_clients WHERE deleted = 0 AND MONTH(created_date) = MONTH(CURDATE()) AND YEAR(created_date) = YEAR(CURDATE())"
              );

              const sourceText =
              sourceType === "group"
                  ? `\nกลุ่ม: ${sourceInfo.groupName || "Unknown"}`
                  : "";

              const statsMessage = `สถิติลูกค้า:

ลูกค้าทั้งหมด: ${totalClients[0].total} คน
วันนี้: ${todayClients[0].today} คน
สัปดาห์นี้: ${thisWeekClients[0].this_week} คน
เดือนนี้: ${thisMonthClients[0].this_month} คน${sourceText}`;

              await sendLineReply(replyToken, statsMessage);
            } catch (error) {
              await sendLineReply(replyToken, "เกิดข้อผิดพลาดในการดึงสถิติ");
            }
          }
          // Group info command (only in groups)
          else if (
            (text === "กลุ่ม" || text === "group") &&
            sourceType === "group"
          ) {
            try {
              const groupSummary = await getGroupSummary(sourceInfo.groupId);
              const groupMessage = `ข้อมูลกลุ่ม:

ชื่อกลุ่ม: ${groupSummary.groupName || "ไม่ทราบชื่อ"}
Group ID: ${sourceInfo.groupId}
จำนวนสมาชิก: ${groupSummary.count || "ไม่ทราบ"} คน`;

              await sendLineReply(replyToken, groupMessage);
            } catch (error) {
              await sendLineReply(replyToken, "ไม่สามารถดึงข้อมูลกลุ่มได้");
            }
          } else {
            // Send help message for unrecognized input
            const sourceText =
              sourceType === "group"
                ? "\n\nใช้งานได้ในกลุ่มและแชทส่วนตัว"
                : "";
            const groupCommands =
              sourceType === "group"
                ? "\n\nคำสั่งเฉพาะกลุ่ม:\n• กลุ่ม หรือ group - ดูข้อมูลกลุ่ม"
                : "";

            const helpMessage = `ไม่เข้าใจคำสั่ง

รูปแบบการใช้งาน:

เพิ่มลูกค้าใหม่:
• คุณกรณี 0641989925 สนใจสินค้าค่ะ
• -คุณสมชาย-0812345678-ต้องการสินค้าด่วน

ค้นหาลูกค้า:
• #ลูกค้า คุณกรณี
• #ลูกค้า 0641989925



พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด${sourceText}`;

            await sendLineReply(replyToken, helpMessage);
          }
        } catch (error) {
          console.error("Error processing text message:", error);
          await sendLineReply(
            replyToken,
            `เกิดข้อผิดพลาด: ${error.message}`
          );
        }
      }

      // Handle join/leave events for groups
      else if (event.type === "join" && sourceType === "group") {
        const welcomeMessage = `สวัสดีครับ! ขอบคุณที่เชิญเข้ากลุ่ม

ฉันเป็นบอทจัดการลูกค้า สามารถช่วยคุณ:
• บันทึกข้อมูลลูกค้าใหม่
• ค้นหาข้อมูลลูกค้า
• ดูสถิติลูกค้า

พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`;

        await sendLineReply(replyToken, welcomeMessage);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Error");
  }
});

// Get group information API
app.get("/api/groups/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params;
    const groupSummary = await getGroupSummary(groupId);
    res.json(groupSummary);
  } catch (error) {
    console.error("Error fetching group info:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(
    `Client Management Server running at http://localhost:${port}`
  );
  console.log("LINE Webhook endpoint: /webhook/line");
  console.log("API Endpoints:");
  console.log("  GET /api/clients - Get all clients");
  console.log("  GET /api/clients/:id - Get client by ID");
  console.log("  GET /api/clients/search?q=<search_term> - Search clients");
  console.log("  GET /api/clients/stats - Get client statistics");
  console.log("  GET /api/groups/:groupId - Get group information");
  console.log("  PUT /api/clients/:id - Update client");
  console.log("  DELETE /api/clients/:id - Delete client");
  console.log("  POST /api/test-client - Test client processing");
  console.log("");
  console.log("LINE Group Features:");
  console.log("  • Works in both private chats and groups");
  console.log("  • Group member profile detection");
  console.log("  • Group-specific commands");
  console.log("  • Welcome message on join");
});

module.exports = app;
