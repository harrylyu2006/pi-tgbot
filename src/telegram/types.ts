/**
 * Hand-written structural subset of the Bot API objects we actually touch.
 *
 * No codegen and no framework types on purpose: this file is small enough to
 * read in one sitting, and if Telegram changes a field we depend on, the break
 * shows up as a compile error rather than as `undefined` at 3am.
 */

export interface TgUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

export interface TgChat {
	id: number;
	type: string;
}

export interface TgMessage {
	message_id: number;
	date: number;
	chat: TgChat;
	from?: TgUser;
	text?: string;
	caption?: string;
	/** Present on voice notes — v1 answers with an explicit "not supported". */
	voice?: { file_id: string; duration: number };
	document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
	photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
	/** Present on sticker messages — v1 downloads and preprocesses them for the text-only model. */
	sticker?: {
		file_id: string;
		file_size?: number;
		width: number;
		height: number;
		/** True for animated (tgs/Lottie) stickers. */
		is_animated?: boolean;
		/** True for video (webm) stickers. */
		is_video?: boolean;
		/** The emoji the sticker is associated with, if the pack declares one. */
		emoji?: string;
		set_name?: string;
	};
	media_group_id?: string;
}

export interface TgCallbackQuery {
	id: string;
	from: TgUser;
	data?: string;
	message?: TgMessage;
}

export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	edited_message?: TgMessage;
	callback_query?: TgCallbackQuery;
}

export interface TgWebhookInfo {
	url: string;
	pending_update_count: number;
}

export interface TgApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface SendMessageParams {
	chat_id: number;
	text: string;
	parse_mode?: "HTML";
	reply_to_message_id?: number;
	link_preview_options?: { is_disabled: boolean };
	reply_markup?: unknown;
}

export interface EditMessageTextParams {
	chat_id: number;
	message_id: number;
	text: string;
	parse_mode?: "HTML";
	link_preview_options?: { is_disabled: boolean };
	reply_markup?: unknown;
}
