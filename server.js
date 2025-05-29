import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs/promises";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Token management
let currentAccessToken = process.env.ZOHO_AUTH_TOKEN;
let tokenExpiryTime = null;

// Function to refresh Zoho access token
async function refreshZohoToken() {
  try {
    console.log("Refreshing Zoho access token...");

    const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    if (data.access_token) {
      currentAccessToken = data.access_token;
      // Set expiry time (typically 1 hour, but we'll refresh 5 minutes early)
      tokenExpiryTime = Date.now() + ((data.expires_in || 3600) - 300) * 1000;

      console.log("✅ Zoho token refreshed successfully");
      console.log(
        `Token expires in: ${Math.round(
          (tokenExpiryTime - Date.now()) / 1000 / 60
        )} minutes`
      );

      return currentAccessToken;
    } else {
      throw new Error("No access token received from refresh");
    }
  } catch (error) {
    console.error("❌ Failed to refresh Zoho token:", error.message);
    throw error;
  }
}

// Function to get valid access token
async function getValidAccessToken() {
  // Check if we need to refresh the token
  if (
    !currentAccessToken ||
    (tokenExpiryTime && Date.now() >= tokenExpiryTime)
  ) {
    await refreshZohoToken();
  }
  return currentAccessToken;
}

// Initialize token on startup if refresh token is available
if (process.env.ZOHO_REFRESH_TOKEN) {
  refreshZohoToken().catch((error) => {
    console.warn(
      "Initial token refresh failed, will retry on first request:",
      error.message
    );
  });
}

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
  console.log("Subscription request received:", req.body);

  try {
    const { email } = req.body;

    // Validation
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

    // Check environment variables
    if (!process.env.ZOHO_LIST_KEY) {
      console.error("Missing Zoho list key");
      return res
        .status(500)
        .json({ success: false, message: "Server configuration error" });
    }

    // Check if we have either static token or refresh capabilities
    if (!currentAccessToken && !process.env.ZOHO_REFRESH_TOKEN) {
      console.error("No Zoho authentication available");
      return res
        .status(500)
        .json({ success: false, message: "Server configuration error" });
    }

    console.log("Getting valid access token...");

    // Get valid access token (will refresh if needed)
    let accessToken;
    try {
      accessToken = await getValidAccessToken();
    } catch (error) {
      console.error("Failed to get valid access token:", error.message);
      return res.status(500).json({
        success: false,
        message: "Authentication error. Please try again later.",
      });
    }

    console.log("Making request to Zoho API...");

    // Prepare the request body - FIXED FORMAT
    const contactData = {
      "Contact Email": email,
      "First Name": "",
      "Last Name": "",
    };

    const requestBody = new URLSearchParams({
      listkey: process.env.ZOHO_LIST_KEY,
      contactinfo: JSON.stringify(contactData),
      resfmt: "JSON",
    });

    console.log("Request body prepared");

    const response = await fetch(
      "https://campaigns.zoho.com/api/v1.1/json/listsubscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Zoho-oauthtoken ${accessToken}`, // Use Authorization header
          "User-Agent": "Newsletter-Subscription-Service/1.0",
        },
        body: requestBody,
        timeout: 15000,
      }
    );

    console.log("Zoho API response status:", response.status);

    if (!response.ok) {
      console.error(
        "Zoho API HTTP error:",
        response.status,
        response.statusText
      );

      // If it's an auth error, try refreshing token once
      if (response.status === 401 && process.env.ZOHO_REFRESH_TOKEN) {
        console.log("Auth error detected, attempting token refresh...");
        try {
          accessToken = await refreshZohoToken();

          // Retry the request with new token - FIXED FORMAT
          const retryContactData = {
            "Contact Email": email,
            "First Name": "",
            "Last Name": "",
          };

          const retryBody = new URLSearchParams({
            listkey: process.env.ZOHO_LIST_KEY,
            contactinfo: JSON.stringify(retryContactData),
            resfmt: "JSON",
          });

          const retryResponse = await fetch(
            "https://campaigns.zoho.com/api/v1.1/json/listsubscribe",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Zoho-oauthtoken ${accessToken}`, // Use Authorization header
                "User-Agent": "Newsletter-Subscription-Service/1.0",
              },
              body: retryBody,
              timeout: 15000,
            }
          );
          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            if (retryData.status === "success") {
              console.log(
                "Subscription successful after token refresh for:",
                email
              );
              return res.json({
                success: true,
                message: "Successfully subscribed to newsletter!",
              });
            }
          }
        } catch (refreshError) {
          console.error("Token refresh retry failed:", refreshError.message);
        }
      }

      return res.status(500).json({
        success: false,
        message:
          "Newsletter service temporarily unavailable. Please try again later.",
      });
    }

    // Handle both JSON and XML responses from Zoho
    const responseText = await response.text();
    console.log("Zoho API raw response:", responseText);

    let data;
    try {
      // Try to parse as JSON first
      data = JSON.parse(responseText);
      console.log("Zoho API response data (JSON):", data);
    } catch (parseError) {
      // If JSON parsing fails, it might be XML (common with Zoho API errors)
      console.log("Response is not JSON, likely XML error response");

      // Check if it contains common error indicators
      if (responseText.includes("<?xml")) {
        // Parse basic error info from XML if possible
        const errorMatch = responseText.match(/<message>(.*?)<\/message>/i);
        const statusMatch = responseText.match(/<status>(.*?)<\/status>/i);

        data = {
          status: statusMatch ? statusMatch[1] : "error",
          message: errorMatch
            ? errorMatch[1]
            : "API returned XML error response",
        };

        console.log("Parsed XML error:", data);
      } else {
        // Unknown response format
        data = {
          status: "error",
          message: "Invalid API response format",
        };
      }
    }

    // Handle successful subscription
    if (data.status === "success") {
      console.log("Subscription successful for:", email);
      return res.json({
        success: true,
        message: "Successfully subscribed to newsletter!",
      });
    }

    // Handle API errors
    console.log("Zoho API returned error:", data);

    let errorMessage = "Subscription failed. Please try again.";

    if (data.message) {
      const message = data.message.toLowerCase();
      if (message.includes("already exists") || message.includes("duplicate")) {
        errorMessage = "This email is already subscribed to our newsletter.";
      } else if (
        message.includes("invalid email") ||
        message.includes("email format")
      ) {
        errorMessage = "Invalid email address provided.";
      } else if (
        message.includes("authentication") ||
        message.includes("token")
      ) {
        console.error("Authentication error with Zoho API");
        errorMessage =
          "Service temporarily unavailable. Please try again later.";
      } else {
        errorMessage = "Unable to complete subscription. Please try again.";
      }
    }

    return res.status(400).json({ success: false, message: errorMessage });
  } catch (error) {
    console.error("Subscription Error Details:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
    });

    // Handle specific error types
    if (error.name === "AbortError" || error.code === "ECONNABORTED") {
      return res.status(504).json({
        success: false,
        message: "Request timeout. Please try again.",
      });
    }

    if (error.name === "FetchError" || error.code === "ENOTFOUND") {
      return res.status(503).json({
        success: false,
        message:
          "Newsletter service temporarily unavailable. Please try again later.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred. Please try again later.",
    });
  }
});

// Test route to verify Zoho API connection
app.get("/api/test-zoho", async (req, res) => {
  try {
    if (!process.env.ZOHO_LIST_KEY) {
      return res.status(500).json({
        success: false,
        message: "Missing Zoho list key",
      });
    }

    if (!currentAccessToken && !process.env.ZOHO_REFRESH_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "No Zoho authentication available",
      });
    }

    // Get valid access token
    const accessToken = await getValidAccessToken();

    // Test with a simple API call
    const response = await fetch(
      "https://campaigns.zoho.com/api/v1.1/json/getlists?resfmt=JSON",
      {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`, // Use Authorization header
        },
        timeout: 10000,
      }
    );

    const data = await response.json();

    res.json({
      success: response.ok,
      status: response.status,
      data: data,
      tokenStatus: {
        hasToken: !!currentAccessToken,
        hasRefreshToken: !!process.env.ZOHO_REFRESH_TOKEN,
        tokenExpiresIn: tokenExpiryTime
          ? Math.round((tokenExpiryTime - Date.now()) / 1000 / 60)
          : null,
      },
      message: response.ok
        ? "Zoho API connection successful"
        : "Zoho API connection failed",
    });
  } catch (error) {
    console.error("Zoho test error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to test Zoho API connection",
      error: error.message,
    });
  }
});

// Manual token refresh endpoint
app.post("/api/refresh-token", async (req, res) => {
  try {
    if (!process.env.ZOHO_REFRESH_TOKEN) {
      return res.status(400).json({
        success: false,
        message: "No refresh token configured",
      });
    }

    const newToken = await refreshZohoToken();

    res.json({
      success: true,
      message: "Token refreshed successfully",
      expiresIn: tokenExpiryTime
        ? Math.round((tokenExpiryTime - Date.now()) / 1000 / 60)
        : null,
    });
  } catch (error) {
    console.error("Manual token refresh error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to refresh token",
      error: error.message,
    });
  }
});

// ✅ Catch-all for invalid routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ✅ Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📧 Newsletter API: http://localhost:${PORT}/api/subscribe`);
  console.log(`🔧 Test Zoho: http://localhost:${PORT}/api/test-zoho`);
});
