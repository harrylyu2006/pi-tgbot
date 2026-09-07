export interface AlbumItem { messageId: number; caption: string; paths: string[]; rejected: string[] }
export interface Album { chatId: number; items: AlbumItem[] }
interface Group { chatId: number; pending: number; quiet: boolean; items: AlbumItem[]; timer: ReturnType<typeof setTimeout> }

/** Register arrival before download. Quiet window AND all downloads must finish. */
export class MediaGroups {
	private groups = new Map<string, Group>();
	private closed = false;
	private readonly flush: (album: Album) => void;
	private readonly delay: number;
	constructor(flush: (album: Album) => void, delay = 600) { this.flush = flush; this.delay = delay; }
	add(id: string, chatId: number, messageId: number, caption: string): (result: { paths: string[]; rejected: string[] }) => void {
		if (this.closed) return () => {};
		let group = this.groups.get(id);
		if (!group) {
			group = { chatId, pending: 0, quiet: false, items: [], timer: undefined as unknown as ReturnType<typeof setTimeout> };
			this.groups.set(id, group);
		}
		const captured = group;
		clearTimeout(group.timer);
		group.quiet = false;
		group.pending++;
		group.timer = setTimeout(() => { captured.quiet = true; this.tryFlush(id, captured); }, this.delay);
		let done = false;
		return (result) => {
			if (done || this.closed || this.groups.get(id) !== captured) return;
			done = true;
			captured.items.push({ messageId, caption, ...result });
			captured.pending--;
			this.tryFlush(id, captured);
		};
	}
	private tryFlush(id: string, group: Group): void {
		if (!group.quiet || group.pending || this.groups.get(id) !== group) return;
		this.groups.delete(id);
		clearTimeout(group.timer);
		this.flush({ chatId: group.chatId, items: group.items.sort((a, b) => a.messageId - b.messageId) });
	}
	close(): void {
		this.closed = true;
		for (const group of this.groups.values()) clearTimeout(group.timer);
		this.groups.clear();
	}
}
