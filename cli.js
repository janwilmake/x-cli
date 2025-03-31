#!/usr/bin/env node
//@ts-check
/**
 * @typedef {Object} RepoConfig
 * @property {string} [community_id] - ID of a community to post in by default for this repo (e.g. "1845745544406151438")
 * @property {string} [lastPostUrl] - URL of the last post made from this repo
 * @property {string} [appendix] - Add this if you wish to remove or alter the default appendix to new threads. Ensure to use {{repoUrl}} in your appendix, as this will be replaced with the URL to your repo or file.
 * @property {Array<ThreadConfig>} [threads] - Threads that are related to this repo. Will be picked up by the CLI to quote them when a new thread is desired.
 */

/**
 * @typedef {Object} GlobalConfig
 * @property {string} username - username of your X
 * @property {string} apiKey - API Key found after login
 */

/**
 * @typedef {Object} ThreadConfig
 * @property {string} slug - url-friendly human-readable identifier for this thread. Can be edited to make it easier to choose which thread to quote.
 * @property {string} [description] - Optional: add some more info about this thread if useful
 * @property {string} url - The URL of a thread to be quoted
 * @property {string} branch - The branch of the repo this thread was about
 * @property {string} createdAt
 * @property {string} updatedAt
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { spawn } = require("child_process");

// Constants
const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".xymake-config.json",
);
const API_BASE_URL = "https://xymake.com";
const CLI_AUTH_URL = `https://xymake.com/login?scope=${encodeURIComponent(
  "users.read follows.read tweet.read offline.access tweet.write",
)}&redirect_uri=https://cli.xymake.com/console`;

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
  let repoRelativePath = "";

  if (args[0] === "-n") {
    isNewThread = true;
    args.shift(); // Remove the -n flag
  }

  // Check if the first argument is a file path
  if (args.length > 0) {
    const potentialPath = args[0];

    // Check if it's an absolute path or a relative path that exists
    if (
      (path.isAbsolute(potentialPath) ||
        potentialPath.startsWith("./") ||
        potentialPath.startsWith("../")) &&
      fs.existsSync(path.resolve(process.cwd(), potentialPath))
    ) {
      // It's a valid file path, remove it from tweet content
      const filePath = path.resolve(process.cwd(), potentialPath);
      args.shift(); // Remove the path from args

      // Get repo info to find the repo root
      const repoInfo = await getRepoInfo();

      try {
        const normalizedRepoRoot = repoInfo.root.trim();

        // Calculate the relative path from repo root
        if (filePath.startsWith(normalizedRepoRoot)) {
          repoRelativePath = path.relative(normalizedRepoRoot, filePath);
        } else {
          console.warn("File is not within the git repository");
        }
      } catch (error) {
        console.warn(`Could not determine repository root: ${error.message}`);
      }
    }
  }

  // Join the remaining arguments as tweet content
  tweetContent = args.join(" ");

  await sendTweet(tweetContent, isNewThread, repoRelativePath);
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
    const state = getStateFile();

    // Find the latest post for this repo and branch

    if (!state.lastPostUrl) {
      console.error("No tweets found for this repository and branch.");
      console.log(`Run 'xy "Your first tweet about this repo"' to create one.`);
      process.exit(1);
    }

    // Construct tweet URL
    console.log(`Opening latest post in your browser: ${state.lastPostUrl}`);

    // Open the tweet in a browser
    openBrowser(state.lastPostUrl);
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
/**
 *
 * @returns {GlobalConfig|null}
 */
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

/**
 * @param {Partial<GlobalConfig>} newConfig
 */
function updateConfig(newConfig) {
  const config = readConfig() || {};
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...config, ...newConfig }, null, 2),
  );
  console.log("Updated config!");
}

/**
 * @param {string} cookie
 * @returns {string|undefined}
 */
const parseAccessToken = (cookie) => {
  const rows = cookie.split(";").map((x) => x.trim());

  // Get X access token from cookies
  const xAccessToken = rows
    .find((row) => row.startsWith("x_access_token="))
    ?.split("=")[1]
    ?.trim();

  return xAccessToken ? decodeURIComponent(xAccessToken) : undefined;
};

/**
 * @returns {Promise<{owner:string,repo:string,branch:string,url:string,root:string}>}
 */
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

    // Get repo root
    const root = (await execPromise("git rev-parse --show-toplevel")).trim();

    return {
      owner,
      repo,
      branch,
      url: `https://github.com/${owner}/${repo}/tree/${branch}`,
      root,
    };
  } catch (error) {
    throw new Error(`Failed to get repository information: ${error.message}`);
  }
}

/**
 * @returns {RepoConfig} state
 */
function getStateFile() {
  try {
    const statePath = path.join(process.cwd(), "xymake.json");
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    }
    return { threads: [] };
  } catch (error) {
    console.error("Error reading state file:", error.message);
    return { threads: [] };
  }
}

/**
 * @param {RepoConfig} state
 */
function saveStateFile(state) {
  try {
    const statePath = path.join(process.cwd(), "xymake.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        { ...state, $schema: "https://cli.xymake.com/xymake.schema.json" },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("Error saving state file:", error.message);
  }
}

/**
 * @param {string} content - content of the tweet
 * @param {boolean} isNewThread - if this is forced by cli to become a new thread
 * @param {string} repoRelativePath - relative path of a file in the repo, will be appended to content, or as repoUrl in appendix if new thread is started.
 */
async function sendTweet(content, isNewThread, repoRelativePath) {
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
    const latestPost = state.threads?.pop();

    let action = "new";
    let tweetId = "";
    let shouldPostAppendix = false;

    if (isNewThread || !latestPost) {
      // Start a new thread
      action = "new";
      shouldPostAppendix = true;
    } else {
      const lastTweetDate = new Date(latestPost.createdAt);
      const now = new Date();
      const daysDiff =
        (now.valueOf() - lastTweetDate.valueOf()) / (1000 * 60 * 60 * 24);

      if (daysDiff > 1) {
        // Quote the old thread if it's more than a day old
        action = "quote";
        tweetId = latestPost.url.split("/").pop() || "";
      } else {
        // Reply to the existing thread
        action = "reply";
        tweetId = latestPost.url.split("/").pop() || "";
      }
    }

    const appendixTemplate =
      state.appendix || `\n\nPowered by X CLI\n {{repoUrl}}`;
    const appendixUrl =
      repoRelativePath === ""
        ? repoInfo.url
        : repoInfo.url + "/" + repoRelativePath;

    const appendix = shouldPostAppendix
      ? appendixTemplate.replace("{{repoUrl}}", appendixUrl)
      : repoRelativePath
      ? appendixUrl
      : "";

    // Send the tweet
    const encodedContent = encodeURIComponent(content + appendix);
    let url;

    const communityIdPart = state.community_id
      ? `&community_id=${state.community_id}`
      : "";

    if (action === "new") {
      url = `${API_BASE_URL}/${config.username}/${action}/${encodedContent}?apiKey=${config.apiKey}&username=${config.username}${communityIdPart}`;
    } else {
      url = `${API_BASE_URL}/${config.username}/${action}/${tweetId}/${encodedContent}?apiKey=${config.apiKey}&username=${config.username}`;
    }

    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    const cookie = response.headers.get("Set-Cookie");
    if (cookie) {
      const apiKey = parseAccessToken(cookie);
      updateConfig({ apiKey });
      console.log("Refreshed API Key: ", { cookie, apiKey });
    }
    const text = await response.text();
    if (!response.ok) {
      const limit = response.headers.get("x-rate-limit-limit");
      const remaining = response.headers.get("x-rate-limit-remaining");
      const reset = response.headers.get("x-rate-limit-reset");

      throw new Error(
        `Failed to post tweet: ${text}, limit=${limit}, remaining=${remaining}, reset=${reset}`,
      );
    }
    const json = JSON.parse(text);

    const username = readConfig()?.username;
    const tweetUrl = `https://x.com/${username}/status/${json.tweet_id}`;
    const threadUrl = latestPost?.url || tweetUrl;
    const alreadyThread = undefined;

    console.log(
      `Post made successfully! ${
        action === "new"
          ? "Started new thread."
          : action === "quote"
          ? "Quoted previous thread."
          : "Replied to existing thread."
      }\n\n${tweetUrl}`,
    );

    const threadsWithoutThis =
      state.threads?.filter(
        (post) =>
          !(post.url === latestPost?.url && post.branch === repoInfo.branch),
      ) || [];
    // Update state
    state.threads = threadsWithoutThis;

    state.threads.push(
      alreadyThread || {
        branch: repoInfo.branch,
        createdAt: new Date(Date.now()).toISOString(),
        slug: `thread${json.tweet_id}`,
        updatedAt: new Date(Date.now()).toISOString(),
        url: threadUrl,
      },
    );

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
    stdin.on(
      "data",
      /** @param {string} data */
      function (data) {
        resolve(data.trim());
        stdin.pause();
      },
    );
  });
}

// Run the main function
main().catch((error) => {
  console.error(`Uncaught error: ${error.message}`);
  process.exit(1);
});
