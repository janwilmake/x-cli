#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { spawn } = require("child_process");
const https = require("https");
const { URL } = require("url");

// Constants
const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".xymake-config.json",
);
const API_BASE_URL = "https://xymake.com";
const CLI_AUTH_URL =
  "https://xymake.com/login?scope=users.read follows.read tweet.read offline.access tweet.write";

// Main function
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    return;
  }

  const command = args[0];

  if (command === "setup") {
    await setupConfig();
    return;
  }

  if (command === "open") {
    await openLatestTweet();
    return;
  }

  // Handle tweet command
  let isNewThread = false;
  let tweetContent = "";

  if (args[0] === "-n") {
    isNewThread = true;
    tweetContent = args.slice(1).join(" ");
  } else {
    tweetContent = args.join(" ");
  }

  await sendTweet(tweetContent, isNewThread);
}

// Open the latest tweet for the current repo/branch
async function openLatestTweet() {
  // Check config
  const config = readConfig();
  if (!config || !config.apiKey || !config.username) {
    console.error(
      'Please run "xy setup" first to configure your API key and username.',
    );
    process.exit(1);
  }

  try {
    // Get repo info
    const repoInfo = await getRepoInfo();
    const state = getStateFile();

    // Find the latest post for this repo and branch
    const latestPost = state.posts.find(
      (post) => post.url === repoInfo.url && post.branch === repoInfo.branch,
    );

    if (!latestPost) {
      console.error("No tweets found for this repository and branch.");
      console.log(`Run 'xy "Your first tweet about this repo"' to create one.`);
      process.exit(1);
    }

    // Construct tweet URL
    const tweetUrl = `https://twitter.com/${config.username}/status/${latestPost.tweetId}`;
    console.log(`Opening latest tweet in your browser: ${tweetUrl}`);

    // Open the tweet in a browser
    openBrowser(tweetUrl);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Update showHelp function to include the new 'open' command
function showHelp() {
  console.log(`
  XYMake CLI - Post tweets about your code
  
  Commands:
    xy setup              Setup your API key and X username
    xy open               Open the latest tweet for current repo/branch in browser
    xy [-n] <message>     Post a tweet with your message
                          Use -n to start a new thread
  
  For more information, visit https://xymake.com
    `);
}

// Setup configuration
async function setupConfig() {
  console.log(
    `Opening ${CLI_AUTH_URL} in your browser. Please authorize and paste your API key here.`,
  );

  // Open browser
  openBrowser(CLI_AUTH_URL);

  // Get API key from user input
  const apiKey = await prompt("Enter your API key: ");

  // Get username from user input
  const username = await prompt("Enter your X username (without @): ");

  // Save configuration
  const config = { apiKey, username };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  console.log("Setup complete! You can now use the xy command to post tweets.");
}

// Read configuration
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (error) {
    console.error("Error reading config file:", error.message);
  }
  return null;
}

// Get repo information
async function getRepoInfo() {
  try {
    // Get remote URL
    const remoteUrl = await execPromise("git remote get-url origin");

    // Check if it's a GitHub URL
    if (!remoteUrl.includes("github.com")) {
      throw new Error("Not a GitHub repository");
    }

    // Extract owner and repo name
    const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) {
      throw new Error("Unable to parse GitHub repository URL");
    }

    const owner = match[1];
    const repo = match[2];

    // Get current branch
    const branch = (
      await execPromise("git rev-parse --abbrev-ref HEAD")
    ).trim();

    return {
      owner,
      repo,
      branch,
      url: `https://github.com/${owner}/${repo}/tree/${branch}`,
    };
  } catch (error) {
    throw new Error(`Failed to get repository information: ${error.message}`);
  }
}

// Read or create state file
function getStateFile() {
  try {
    const statePath = path.join(process.cwd(), "xymake.json");
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    }
    return { posts: [] };
  } catch (error) {
    console.error("Error reading state file:", error.message);
    return { posts: [] };
  }
}

// Save state file
function saveStateFile(state) {
  try {
    const statePath = path.join(process.cwd(), "xymake.json");
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Error saving state file:", error.message);
  }
}

// Send a tweet
async function sendTweet(content, isNewThread) {
  // Check config
  const config = readConfig();
  if (!config || !config.apiKey || !config.username) {
    console.error(
      'Please run "xy setup" first to configure your API key and username.',
    );
    process.exit(1);
  }

  try {
    // Get repo info
    const repoInfo = await getRepoInfo();
    const state = getStateFile();

    // Find the latest post for this repo and branch
    const latestPost = state.posts.find(
      (post) => post.url === repoInfo.url && post.branch === repoInfo.branch,
    );

    let action = "new";
    let tweetId = "";
    let shouldPostRepoUrl = false;

    if (!isNewThread && latestPost) {
      const lastTweetDate = new Date(latestPost.createdAt);
      const now = new Date();
      const daysDiff = (now - lastTweetDate) / (1000 * 60 * 60 * 24);

      if (daysDiff > 1) {
        // Quote the old thread if it's more than a day old
        action = "quote";
        tweetId = latestPost.tweetId;
      } else {
        // Reply to the existing thread
        action = "reply";
        tweetId = latestPost.tweetId;
      }
    } else {
      // Start a new thread
      action = "new";
      shouldPostRepoUrl = true;
    }

    // Send the tweet
    const encodedContent = encodeURIComponent(content);
    let url;

    if (action === "new") {
      url = `${API_BASE_URL}/${config.username}/${action}/${encodedContent}?apiKey=${config.apiKey}`;
    } else {
      url = `${API_BASE_URL}/${config.username}/${action}/${tweetId}/${encodedContent}?apiKey=${config.apiKey}`;
    }

    const response = await fetch(url);

    const json = await response.json();
    if (!response.ok) {
      const limit = response.headers.get("x-rate-limit-limit");
      const remaining = response.headers.get("x-rate-limit-remaining");
      const reset = response.headers.get("x-rate-limit-reset");
      const data = { json, ratelimit: { limit, remaining, reset } };
      console.log({ content, encodedContent });
      throw new Error(`Failed to post tweet: ${JSON.stringify(data)}`);
    }

    console.log(
      `Tweet posted successfully! ${
        action === "new"
          ? "Started new thread."
          : action === "quote"
          ? "Quoted previous thread."
          : "Replied to existing thread."
      }`,
    );

    // Post repo URL as a reply if this is a new thread
    if (shouldPostRepoUrl) {
      const repoUrlContent = `Here's the repo (powered by X CLI) \n ${repoInfo.url}`;
      const repoUrlEncodedContent = encodeURIComponent(repoUrlContent);
      const repoUrlTweetUrl = `${API_BASE_URL}/${config.username}/reply/${response.tweet_id}/${repoUrlEncodedContent}?apiKey=${config.apiKey}`;

      const repoUrlResponse = await fetchJson(repoUrlTweetUrl);

      if (!repoUrlResponse.success) {
        console.warn(
          `Warning: Failed to post repo URL tweet: ${JSON.stringify(
            repoUrlResponse,
          )}`,
        );
      } else {
        console.log("Repo URL posted as a reply.");
      }
    }

    // Update state
    state.posts = state.posts.filter(
      (post) => !(post.url === repoInfo.url && post.branch === repoInfo.branch),
    );

    state.posts.push({
      url: repoInfo.url,
      branch: repoInfo.branch,
      tweetId: response.tweet_id,
      createdAt: new Date().toISOString(),
    });

    saveStateFile(state);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Helper functions
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function openBrowser(url) {
  let command;
  const args = [];

  switch (process.platform) {
    case "darwin":
      command = "open";
      args.push(url);
      break;
    case "win32":
      command = "cmd.exe";
      args.push("/c", "start", url);
      break;
    default:
      command = "xdg-open";
      args.push(url);
      break;
  }

  spawn(command, args, { detached: true });
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");

    stdin.on("data", function (data) {
      resolve(data.trim());
      stdin.pause();
    });
  });
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "XYMake CLI",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data);

          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.end();
  });
}

// Run the main function
main().catch((error) => {
  console.error(`Uncaught error: ${error.message}`);
  process.exit(1);
});
