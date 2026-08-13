export interface SteerableSession {
	readonly isStreaming: boolean;
	steer(text: string): Promise<void>;
}

/**
 * Deliver a Telegram message into the active Pi agent run when possible.
 *
 * Pi steering is not a separate FIFO job: the message becomes a real user
 * message after the current assistant turn (including its tool calls) reaches
 * the next model boundary. It therefore matches the mid-run input behavior of
 * interactive coding agents without aborting a tool that is already running.
 */
export async function steerIfStreaming(session: SteerableSession, text: string): Promise<boolean> {
	if (!session.isStreaming) return false;
	await session.steer(text);
	return true;
}
