import console from "./console.html";
const loginLocation = `https://xymake.com/login?scope=${encodeURIComponent(
  "users.read follows.read tweet.read offline.access tweet.write",
)}&redirect_uri=${encodeURIComponent("https://cli.xymake.com/console")}`;

export default {
  fetch: async (request, env, ctx) => {
    const url = new URL(request.url);
    // Check if this is the dashboard endpoint
    if (url.pathname !== "/console") {
      return new Response("Only path allowed: /console", { status: 404 });
    }

    // Get access token from cookies
    const cookie = request.headers.get("Cookie") || "";
    const rows = cookie.split(";").map((x) => x.trim());
    const xAccessToken = rows
      .find((row) => row.startsWith("x_access_token="))
      ?.split("=")[1]
      ?.trim();
    const accessToken = xAccessToken ? decodeURIComponent(xAccessToken) : null;
    if (!accessToken) {
      // Redirect to login if not authenticated
      return new Response("Unauthorized", {
        status: 307,
        headers: {
          Location: loginLocation,
        },
      });
    }

    try {
      // Check token scopes by making a request to X API
      const scopeResponse = await fetch(
        "https://api.x.com/2/oauth2/token/info",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      let hasTweetScope = false;
      if (scopeResponse.ok) {
        try {
          const tokenInfo = await scopeResponse.json();
          const scopes = tokenInfo?.scopes || [];
          hasTweetScope = scopes.includes("tweet.write");
        } catch {}
      }
      // Also get username for display
      const userResponse = await fetch(
        "https://api.x.com/2/users/me?user.fields=username,profile_image_url",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      if (userResponse.status === 401 || userResponse.status === 403) {
        // Redirect to login if not authenticated
        return new Response("Unauthorized", {
          status: 307,
          headers: {
            Location: loginLocation,
          },
        });
      }
      if (userResponse.status === 429) {
        // Redirect to login if not authenticated
        return new Response("429 hit", {
          status: 307,
          headers: {
            Location: "/429",
          },
        });
      }
      if (!userResponse.ok) {
        return new Response(
          `Failed to fetch user data: ${userResponse.status}`,
          { status: userResponse.status },
        );
      }

      const userData = await userResponse.json();
      const { username, profile_image_url } = userData.data;
      // Replace placeholders in the dashboard HTML

      let consoleFinalHtml = console
        .replaceAll("{{username}}", username)
        .replaceAll("{{profile_image_url}}", profile_image_url)
        .replaceAll("{{apiKey}}", accessToken)
        .replaceAll("{{hasTweetScope}}", hasTweetScope ? "true" : "false");

      return new Response(consoleFinalHtml, {
        headers: { "content-type": "text/html;charset=utf8" },
      });
    } catch (error) {
      return new Response(
        `Error loading dashboard: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        {
          status: 500,
        },
      );
    }
  },
};
