// src/commands.ts
import express from "express";
import open from "open";
import Conf from "conf";
import fetch from "node-fetch";
import crypto from "crypto";

const config = new Conf({ projectName: "xpost-cli" });
const API_BASE = "https://xlogin.wilmake.com";

function generateRandomString(length: number): string {
  return crypto.randomBytes(length).toString("hex");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(verifier);
  return hash.digest("base64url");
}

export async function login(): Promise<void> {
  const app = express();
  const server = app.listen(3000);

  const state = generateRandomString(16);
  const codeVerifier = generateRandomString(43);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  app.get("/callback", async (req, res) => {
    const { code, state: returnedState } = req.query;

    if (state !== returnedState) {
      res.send("Invalid state parameter");
      server.close();
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get access token");
      }

      const { access_token } = await response.json();
      config.set("access_token", access_token);

      res.send("Successfully logged in! You can close this window.");
      server.close();
      console.log("Successfully logged in!");
    } catch (error) {
      res.send("Failed to login. Please try again.");
      server.close();
      console.error("Login failed:", error);
    }
  });

  const loginUrl = `${API_BASE}/login?code_challenge=${codeChallenge}&state=${state}`;
  await open(loginUrl);
  console.log("Opening browser for authentication...");
}

export async function post(message: string): Promise<void> {
  const accessToken = config.get("access_token");

  try {
    const response = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: message }),
    });

    if (!response.ok) {
      throw new Error(`Failed to post: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(
      `Posted successfully! View at: https://x.com/i/status/${data.data.id}`,
    );
  } catch (error) {
    console.error("Failed to post:", error);
    process.exit(1);
  }
}

export async function isLoggedIn(): Promise<boolean> {
  return Boolean(config.get("access_token"));
}

export async function logout(): Promise<void> {
  config.delete("access_token");
  console.log("Logged out successfully");
}
