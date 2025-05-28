import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS setup - allow any frontend to access
app.use(
  cors({
    origin: "*", // or specify: ["https://your-frontend.com"]
    credentials: true,
  })
);

// Middleware
app.use(express.json());

// ✅ Health check route
app.get("/api/health", (req, res) => {
  res.json({
    status: "Server is running!",
    timestamp: new Date().toISOString(),
  });
});

// ✅ Newsletter subscription
app.post("/api/subscribe", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    if (!process.env.ZOHO_AUTH_TOKEN || !process.env.ZOHO_LIST_KEY) {
      return res
        .status(500)
        .json({ success: false, message: "Server configuration error" });
    }

    const response = await fetch(
      "https://campaigns.zoho.com/api/v1.1/json/listsubscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          authtoken: process.env.ZOHO_AUTH_TOKEN,
          scope: "CampaignsAPI",
          listkey: process.env.ZOHO_LIST_KEY,
          contactinfo: JSON.stringify({
            "Contact Email": email,
            Source: "Website Newsletter",
            "Signup Date": new Date().toISOString(),
          }),
        }),
      }
    );

    const data = await response.json();

    if (data.status === "success") {
      return res.json({
        success: true,
        message: "Successfully subscribed to newsletter!",
      });
    }

    let errorMessage = "Subscription failed. Please try again.";
    if (data.message?.includes("already exists")) {
      errorMessage = "This email is already subscribed to our newsletter.";
    } else if (data.message?.includes("invalid")) {
      errorMessage = "Invalid email address provided.";
    } else if (data.message) {
      errorMessage = data.message;
    }

    res.status(400).json({ success: false, message: errorMessage });
  } catch (error) {
    console.error("Subscription Error:", error.message);
    res.status(500).json({
      success: false,
      message: "An unexpected error occurred. Please try again later.",
    });
  }
});

// ✅ Catch-all for invalid routes (FIXED)
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ✅ Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
