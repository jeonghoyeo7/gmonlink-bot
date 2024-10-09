import { Bot } from 'grammy';
import * as mime from 'mime-types';

import { Conversation } from '@grammyjs/conversations';

import { MyContext } from '../../bot';
import { botSettings } from '../../config';
import { ActSupabaseClient } from '../clients/supabase';
import {
  activeProjectRecord,
  isInConversationRecord,
  projectRecord,
} from '../records';
import { getUser } from '../users/get-user';
import { createSlug } from '../utils';
import { sendTipMessage } from './send-message';

type MyConversation = Conversation<MyContext>;

const errorMessages = {
	invalidProjectName: "Please provide a valid project name.",
	invalidProjectUrl: "Please provide a valid project URL.",
};

const steps = 3;
const botToken = process.env.BOT_TOKEN!;

// Helper function to extract username from URL
function extractUsernameFromUrl(url: string, platform: "twitter" | "github"): string | null {
    let regex;
    if (platform === "twitter") {
        regex = /(?:https?:\/\/)?(?:www\.)?twitter\.com\/([a-zA-Z0-9_]+)/i;
    } else if (platform === "github") {
        regex = /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_-]+)/i;
    }
    const match = url.match(regex);
    return match ? match[1] : null;
}

export async function createProject(conversation: MyConversation, ctx: MyContext, supabase: ActSupabaseClient, bot: Bot<MyContext>) {
	const userId = ctx.from?.id!;
	const user = await getUser(userId, supabase, bot);
	isInConversationRecord[userId] = true

	await sendTipMessage(ctx);

	// 1. Get the project name
	await ctx.reply(`<code>[1/${steps}]</code>\nSure! Let's create a new project. What's the name of the project or person you're creating a gmon.link for?`, {
		parse_mode: "HTML",
	});
	const projectName = await conversation.form.text(async (ctx) => {
		await ctx.reply(errorMessages.invalidProjectName);
	});

	// 2. Get the project description
	await ctx.reply(`<code>[2/${steps}]</code>\nGreat! <code>${projectName}</code> it is. Now, let's write a short description for the project.`, {
		parse_mode: "HTML",
	});
	const projectDescription = await conversation.form.text(async (ctx) => {
		await ctx.reply("Please provide a valid description.");
	});

	// 3. Twitter ID or URL
    await ctx.reply(`<code>[3/${steps}]</code>\nDo you have a Twitter handle or a Twitter URL? Please provide it. Type "no" if you don't want to add it.`, { parse_mode: "HTML" });
    const twitterInput = await conversation.form.text(async (ctx) => {
        await ctx.reply("Please provide a valid input (Twitter handle/URL or 'no').");
    });

    let twitterId = twitterInput;
	if (twitterInput.startsWith("http")) {
		twitterId = extractUsernameFromUrl(twitterInput, "twitter");

		// **Validation**: If extraction fails, prompt the user and stop execution
		if (!twitterId) {
			await ctx.reply("⚠️ The provided Twitter URL is invalid. Please try again or type 'no'.");
			return;  // Stops further execution if invalid input
		}
	}
    const twitterLink = twitterId !== "no" ? `https://twitter.com/${twitterId}` : null;

    // 4. GitHub ID or URL
    await ctx.reply(`<code>[4/${steps}]</code>\nDo you have a GitHub ID or GitHub URL? Please provide it. Type "no" to skip.`, { parse_mode: "HTML" });
    const githubInput = await conversation.form.text(async (ctx) => {
        await ctx.reply("Please provide a valid input (GitHub handle/URL or 'no').");
    });

    let githubId = githubInput;
    if (githubInput.startsWith("http")) {
		githubId = extractUsernameFromUrl(githubInput, "github");
	
		// **Validation**: If extraction fails, prompt the user and stop execution
		if (!githubId) {
			await ctx.reply("⚠️ The provided GitHub URL is invalid. Please try again or type 'no'.");
			return;  // Stops further execution if invalid input
		}
	}
    const githubLink = githubId !== "no" ? `https://github.com/${githubId}` : null;

	// 5. Add an image
	await ctx.reply(`<code>[5/${steps}]</code>\nFab! Let's add an image for the project. Send a photo or an image of the project.`, { parse_mode: "HTML" });
	const { message } = await conversation.waitFor(["message:photo"]);

	if (!message || !message.photo) {
		await ctx.reply("Please provide a valid image.");
		return;
	}

	const uploadingMessage = await ctx.reply("⏳ We're uploading your image...");
	const slug = await createSlug(projectName, supabase);

	let imageData: any;
	try {
		const imageId = message.photo[message.photo.length - 1].file_id;
		const image = await bot.api.getFile(imageId);
		const projectImage = `https://api.telegram.org/file/bot${botToken}/${image.file_path}`;

		// Fetch the image as an ArrayBuffer
		const response = await fetch(projectImage);
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		// Get file extension and MIME type
        if (!image.file_path) throw new Error("No file path found in the image.");

		const fileExtension = image.file_path.split(".").pop() || "jpg";
		const contentType = mime.lookup(fileExtension) || "image/jpeg";

		const fileName = `${slug}.${fileExtension}`;

		const { data: imageRes, error } = await supabase.storage.from("gmon.link").upload(fileName, buffer, {
			upsert: true,
			contentType: contentType,
		});

		if (error) throw error;

		imageData = imageRes;
		await ctx.api.editMessageText(ctx.chat!.id, uploadingMessage.message_id, "✅ Image uploaded successfully!");
	} catch (error) {
		console.error("Error:", error);
		await ctx.api.editMessageText(ctx.chat!.id, uploadingMessage.message_id, "❌ Sorry, there was an error uploading your image.");
	}

	await ctx.api.editMessageText(ctx.chat!.id, uploadingMessage.message_id, "🎉 Image uploaded successfully!");

	const imageUrl = imageData.fullPath;
	console.log(imageUrl);

	await ctx.api.editMessageText(ctx.chat!.id, uploadingMessage.message_id, "⏳ We're creating your project...");
	const { data, error: insertError } = await supabase
		.from("projects")
		.insert({ user_id: userId, title: projectName, description: projectDescription, slug, avatar_url: imageUrl, 
			links: [
                ...(twitterLink ? [{ title: "Twitter", url: twitterLink }] : []),
                ...(githubLink ? [{ title: "GitHub", url: githubLink }] : []),
            ],
		 })
		.select("*")
		.single();
	if (insertError || !data) {
		await ctx.reply("An error occurred while creating the project. Please try again.");
		throw new Error(insertError?.message);
	}

	projectRecord[userId] = data;
	activeProjectRecord[userId] = data.project_id;

	await ctx.api.editMessageText(
		ctx.chat!.id,
		uploadingMessage.message_id,
		`🎉 <b>Project created successfully!</b> Here's the link to the project: <a href="gmon.link/${slug}">gmon.link/${slug}</a>`,
		{ parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Add a Link", callback_data: "create-link" }]] } }
	);

	await ctx.api.sendMessage(botSettings.alertsChannelId, `${user.username} created a new project. <a href="gmon.link/${slug}">gmon.link/${slug}</a>`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });

	return;
}
