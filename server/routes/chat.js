import { Router } from "express";
import dotnet from "dotenv";
import user from "../helpers/user.js";
import jwt from "jsonwebtoken";
import chat from "../helpers/chat.js";
import OpenAI, { toFile } from "openai";
import { db } from "../db/connection.js";
import collections from "../db/collections.js";
import multer from "multer";
import fs from "fs";
import { ObjectId } from "mongodb";
dotnet.config();

let router = Router();
const upload = multer({ dest: "uploads/" });

const CheckUser = async (req, res, next) => {
  // Middleware to check if user is logged in by verifying JWT token
  jwt.verify(req.cookies?.userToken, process.env.JWT_PRIVATE_KEY, async (err, decoded) => {
    if (decoded) {
      let userData = null;

      try {
        userData = await user.checkUserFound(decoded);
      } catch (err) {
        if (err?.notExists) {
          res.clearCookie("userToken").status(405).json({ status: 405, message: err?.text });
        } else {
          res.status(500).json({ status: 500, message: err });
        }
      } finally {
        if (userData) {
          req.body.userId = userData._id;
          next();
        }
      }
    } else {
      res.status(405).json({ status: 405, message: "Not Logged" });
    }
  });
};

const client = new OpenAI({ apiKey: "api-key" });
const openai = new OpenAI({ apiKey: "api-key"});

router.get("/", (req, res) => {
  // Route to display welcome message
  res.send("Welcome to chatGPT api v1");
});

router.get("/upload", CheckUser, async (req, res) => {
  // Route to get uploaded file information
  const { userId } = req.body;
  const { chatId } = req.query;
  let chat = await db.collection(collections.CHAT).findOne({ user: userId.toString(), "data.chatId": chatId });
  if (chat) {
    chat = chat.data.filter((obj) => obj.chatId === chatId)[0];
    res.status(200).json({ status: 200, message: "Success", data: chat.file_name });
  } else {
    res.status(404).json({ status: 404, message: "Not found" });
  }
});

router.post("/upload", upload.single("file"), CheckUser, async (req, res) => {
  // Route to upload file, send it to OpenAI, and store file info in MongoDB
  const { userId, chatId } = req.body;
  const file = fs.createReadStream(req.file?.path);
  let response = null;
  try {
    response = await client.files.create({ purpose: "assistants", file: file });
  } catch (err) {
    console.log(err);
    res.status(500).json({ status: 500, message: err });
    return;
  }
  // Code to handle file upload and update MongoDB
  if (response) {
    const file_id = response.id;
    const file_name = req.file.originalname;
    // Check if chat exists and update MongoDB accordingly
    let chatIdToSend = null;
    const chat = await db.collection(collections.CHAT).aggregate([
      { $match: { user: userId.toString() } },
      { $unwind: "$data" },
      { $match: { "data.chatId": chatId } },
      { $project: { files: "$data.files" } },
    ]).toArray();
    let all_files = chat[0]?.files?.length > 0 ? [...chat[0].files, file_id] : [file_id];
    const assistant = await client.beta.assistants.create({
      name: "GE CoPilot",
      instructions: "You are a helpful assistant that answers what is asked. Retrieve the relevant information from the files.",
      tools: [{ type: "retrieval" }, { type: "code_interpreter" }],
      model: "gpt-4-0125-preview",
      file_ids: all_files,
    });
    if (chat.length > 0) {
      chatIdToSend = chatId;
      await db.collection(collections.CHAT).updateOne(
        { user: userId.toString(), "data.chatId": chatId },
        {
          $addToSet: { "data.$.files": file_id, "data.$.file_name": file_name },
          $set: { "data.$.assistant_id": assistant.id },
        }
      );
    } else {
      const newChatId = new ObjectId().toHexString();
      chatIdToSend = newChatId;
      await db.collection(collections.CHAT).updateOne(
        { user: userId.toString() },
        {
          $push: {
            data: {
              chatId: newChatId,
              files: [file_id],
              file_name: [file_name],
              chats: [],
              chat: [],
              assistant_id: assistant.id,
            },
          },
        },
        { new: true, upsert: true }
      );
    }

    res.status(200).json({ status: 200, message: "Success", data: { file_id, file_name, chatId: chatIdToSend } });
  }
});

router.post("/", CheckUser, async (req, res) => {
  // Route to handle new chat prompt and get response from OpenAI
  const { prompt, userId } = req.body;
  let response = {};
  try {
    console.log("POST is being called", req.body);
    response.openai = await openai.chat.completions.create({
      model: "gpt-4-0125-preview",
      messages: [
        { role: "system", content: "You are a helpful assistant that answers what is asked. Don't show the mathematical steps if not asked." },
        { role: "user", content: prompt },
      ],
      top_p: 0.5,
    });
    if (response.openai.choices[0].message) {
      response.openai = response.openai.choices[0].message.content;
      response.db = await chat.newResponse(prompt, response, userId);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json({ status: 500, message: err });
  } finally {
    if (response?.db && response?.openai) {
      res.status(200).json({ status: 200, message: "Success", data: { _id: response.db["chatId"], content: response.openai } });
    }
  }
});

router.put("/", CheckUser, async (req, res) => {
  // Route to handle continuation of an existing chat prompt
  const { prompt, userId, chatId } = req.body;
  console.log("PUT is being called", req.body);
  let mes = { role: "system", content: "You are a helpful assistant that answers what is asked. Don't show the mathematical steps if not asked." };
  let full = "";
  let message = await chat.Messages(userId, chatId);
  message = message[0].chats;
  mes = [mes, ...message];
  mes = [...mes, { role: "user", content: prompt }];
  let response = {};
  let new_chat = await db.collection(collections.CHAT).findOne({ user: userId.toString(), data: { $elemMatch: { chatId: chatId } } });
  new_chat = new_chat.data.filter((obj) => obj.chatId === chatId)[0];
  const assistant_id = new_chat.assistant_id;
  try {
    if (assistant_id) {
      console.log("Assistant running");
      const thread = await client.beta.threads.create({ messages: [{ role: "user", content: prompt }] });
      const run = await client.beta.threads.runs.create(thread.id, { assistant_id: assistant_id });
      let final_run = "";
      while (final_run.status !== "completed") {
        final_run = await client.beta.threads.runs.retrieve(thread.id, run.id);
      }
      console.log(final_run.status);
      const messages = await client.beta.threads.messages.list(thread.id);
      response = { openai: messages.data[0].content[0].text.value };
      if (response.openai) {
        response.db = await chat.Response(prompt, response, userId, chatId, assistant_id);
      }
    } else {
      response.openai = await openai.chat.completions.create({ model: "gpt-4-0125-preview", messages: mes, top_p: 0.52, stream: true });
      for await (const part of response.openai) {
        let text = part.choices[0].delta.content ?? "";
        full += text;
      }
      response.openai = { role: "assistant", content: full };
      if (response.openai) {
        response.db = await chat.Response(prompt, response, userId, chatId, assistant_id);
      }
    }
  } catch (err) {
    console.log(err);
    res.status(500).json({ status: 500, message: err });
  } finally {
    if (response?.db && response?.openai) {
      res.status(200).json({ status: 200, message: "Success", data: { content: response.openai, chatId: chatId } });
    }
  }
});

router.get("/saved", CheckUser, async (req, res) => {
  // Route to retrieve saved chat based on chat ID
  const { userId } = req.body;
  const { chatId } = req.query;
  const response = await db.collection(collections.CHAT).aggregate([
    { $match: { user: userId.toString() } },
    { $unwind: "$data" },
    { $match: { "data.chatId": chatId } },
    { $project: { messages: "$data.chats" } },
  ]).toArray();
  if (response.length > 0) {
    res.status(200).json({ status: 200, message: "Success", data: response[0] });
  } else {
    res.status(404).json({ status: 404, message: "Not found" });
  }
});

router.get("/history", CheckUser, async (req, res) => {
  // Route to retrieve chat history for authenticated user
  const { userId } = req.body;
  const response = await db.collection(collections.CHAT).aggregate([
    { $match: { user: userId.toString() } },
    { $unwind: "$data" },
    { $project: { chatId: "$data.chatId" } },
  ]).toArray();
  if (response.length > 0) {
    res.status(200).json({ status: 200, message: "Success", data: response });
  } else {
    res.status(404).json({ status: 404, message: "No history found" });
  }
});

router.delete("/all", CheckUser, async (req, res) => {
  // Route to delete all chat records for the authenticated user
  const { userId } = req.body;
  const response = await db.collection(collections.CHAT).deleteOne({ user: userId.toString() });
  if (response) {
    res.status(200).json({ status: 200, message: "Deleted successfully" });
  } else {
    res.status(500).json({ status: 500, message: "Failed to delete" });
  }
});

router.post("/getfile", CheckUser, async (req, res) => {
  // Route to get files associated with a specific chat ID
  const { chatId, userId } = req.body;
  const chat = await db.collection(collections.CHAT).aggregate([
    { $match: { user: userId.toString() } },
    { $unwind: "$data" },
    { $match: { "data.chatId": chatId } },
    { $project: { files: "$data.file_name" } },
  ]).toArray();
  if (chat.length > 0) {
    res.status(200).json({ status: 200, message: "Success", data: chat[0]?.files });
  } else {
    res.status(404).json({ status: 404, message: "Not found" });
  }
});

router.post("/deletefile", CheckUser, async (req, res) => {
  // Route to delete a specific file from a chat based on file name
  const { chatId, userId, file_name } = req.body;
  const chat = await db.collection(collections.CHAT).aggregate([
    { $match: { user: userId.toString() } },
    { $unwind: "$data" },
    { $match: { "data.chatId": chatId } },
    { $project: { files: "$data.file_name", fileId: "$data.files", assistant_id: "$data.assistant_id" } },
  ]).toArray();
  const fileIndex = chat[0]?.files?.indexOf(file_name);
  if (chat.length > 0) {
    const newAssistant = chat[0]?.assistant_id;
    if (fileIndex > -1) {
      let newFiles = chat[0].files.filter((file) => file !== file_name);
      let newFilesId = chat[0].fileId.filter((file, index) => index !== fileIndex);
      if (newAssistant) {
        const assistant = await client.beta.assistants.create({
          name: "GE CoPilot",
          instructions: "You are a helpful assistant that answers what is asked. Retrieve the relevant information from the files.",
          tools: [{ type: "retrieval" }, { type: "code_interpreter" }],
          model: "gpt-4-0125-preview",
          file_ids: newFilesId,
        });
        await db.collection(collections.CHAT).updateOne(
          { user: userId.toString(), "data.chatId": chatId },
          { $set: { "data.$.files": newFilesId, "data.$.file_name": newFiles, "data.$.assistant_id": assistant.id } }
        );
      }
    }
    res.status(200).json({ status: 200, message: "Deleted successfully" });
  } else {
    res.status(404).json({ status: 404, message: "Not found" });
  }
});

router.post("/update_profile", CheckUser, async (req, res) => {
  // Route to update user profile details (email, first name, last name, profile picture)
  const { userId, email, firstName, lastName, profile } = req.body;
  try {
    await db.collection(collections.USERS).updateOne(
      { _id: new ObjectId(userId) },
      { $set: { email: email, firstName: firstName, lastName: lastName, profile: profile } }
    );
    res.status(200).json({ status: 200, message: "Profile updated successfully" });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to update profile" });
  }
});

router.get("/checkLogged", CheckUser, async (req, res) => {
  // Route to check if user is already logged in
  res.status(200).json({ status: 200, message: "User is logged in" });
});

router.post("/signup", async (req, res) => {
  // Route to handle user sign-up and email verification
  const { email, firstName, lastName, password } = req.body;
  try {
    const newUser = await user.create(email, firstName, lastName, password);
    await user.sendEmailVerification(email);
    res.status(200).json({ status: 200, message: "Sign-up successful, please check your email for verification link" });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to sign up" });
  }
});

router.get("/checkPending", async (req, res) => {
  // Route to check the status of pending sign-ups
  const { email } = req.query;
  try {
    const isPending = await user.isPending(email);
    res.status(200).json({ status: 200, message: "Pending status checked", data: isPending });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to check pending status" });
  }
});

router.put("/signup-finish", async (req, res) => {
  // Route to complete the sign-up process
  const { email, token } = req.body;
  try {
    const user = await user.completeSignUp(email, token);
    const token = jwt.sign({ _id: user._id }, process.env.JWT_PRIVATE_KEY, { expiresIn: "1h" });
    res.cookie("userToken", token, { httpOnly: true, secure: true }).status(200).json({ status: 200, message: "Sign-up completed", data: { userId: user._id } });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to complete sign-up" });
  }
});

router.get("/login", async (req, res) => {
  // Route to handle user login, including OAuth2 token verification
  const { email, password } = req.query;
  try {
    const user = await user.login(email, password);
    const token = jwt.sign({ _id: user._id }, process.env.JWT_PRIVATE_KEY, { expiresIn: "1h" });
    res.cookie("userToken", token, { httpOnly: true, secure: true }).status(200).json({ status: 200, message: "Login successful", data: { userId: user._id } });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to login" });
  }
});

router.post("/forgot-request", async (req, res) => {
  // Route to initiate password reset request by sending email with reset link
  const { email } = req.body;
  try {
    await user.sendPasswordReset(email);
    res.status(200).json({ status: 200, message: "Password reset link sent to email" });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to send password reset link" });
  }
});

router.get("/forgot-check", async (req, res) => {
  // Route to verify the password reset request
  const { email, token } = req.query;
  try {
    const isValid = await user.verifyPasswordResetToken(email, token);
    res.status(200).json({ status: 200, message: "Password reset token verified", data: isValid });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to verify password reset token" });
  }
});

router.put("/forgot-finish", async (req, res) => {
  // Route to complete the password reset process
  const { email, token, newPassword } = req.body;
  try {
    const user = await user.resetPassword(email, token, newPassword);
    res.status(200).json({ status: 200, message: "Password reset successful", data: { userId: user._id } });
  } catch (err) {
    res.status(500).json({ status: 500, message: "Failed to reset password" });
  }
});

export default router;
