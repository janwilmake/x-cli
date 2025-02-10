#!/usr/bin/env node
import { program } from "commander";
import { login, post, isLoggedIn, logout } from "./index.js";

program.name("xpost").description("CLI tool for posting to X");

program.command("login").description("Login to X").action(login);

program
  .command("post <message>")
  .description("Post a message to X")
  .action(async (message) => {
    if (!(await isLoggedIn())) {
      console.log("Please login first using: xpost login");
      process.exit(1);
    }
    await post(message);
  });

program.command("logout").description("Logout from X").action(logout);

// Default command for direct posting
if (
  process.argv.length === 3 &&
  !["login", "logout", "post"].includes(process.argv[2])
) {
  const message = process.argv[2];
  program.parse(["", "", "post", message]);
} else {
  program.parse();
}
