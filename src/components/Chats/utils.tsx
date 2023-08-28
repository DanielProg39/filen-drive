import { useEffect, createElement, memo, useRef, Fragment, Children } from "react"
import { ChatMessage, ChatConversationParticipant, chatConversations, ChatConversation, chatMessages } from "../../lib/api"
import { UserGetAccount } from "../../types"
import db from "../../lib/db"
import { decryptChatMessage, decryptChatConversationName } from "../../lib/worker/worker.com"
import { validate } from "uuid"
import { MessageDisplayType } from "./Container"
import regexifyString from "regexify-string"
import EMOJI_REGEX from "emojibase-regex"
import { Emoji } from "emoji-mart"
import { getColor } from "../../styles/colors"
import { Link, Flex, Text } from "@chakra-ui/react"
import { customEmojis } from "./customEmojis"
import eventListener from "../../lib/eventListener"

export const MENTION_REGEX = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/g

export const customEmojisList = customEmojis.map(emoji => emoji.id)

export const getUserNameFromMessage = (message: ChatMessage): string => {
	return message.senderNickName.length > 0 ? message.senderNickName : message.senderEmail
}

export const getUserNameFromReplyTo = (message: ChatMessage): string => {
	return message.replyTo.senderNickName.length > 0 ? message.replyTo.senderNickName : message.replyTo.senderEmail
}

export const getUserNameFromParticipant = (participant: ChatConversationParticipant): string => {
	return participant.nickName.length > 0 ? participant.nickName : participant.email
}

export const getUserNameFromAccount = (account: UserGetAccount): string => {
	return account.nickName.length > 0 ? account.nickName : account.email
}

export const formatDate = (date: Date): string => {
	return date.toLocaleDateString(window.navigator.language, { year: "numeric", month: "2-digit", day: "2-digit" })
}

export const formatTime = (date: Date): string => {
	return date.toLocaleTimeString(window.navigator.language, { hour: "2-digit", minute: "2-digit" })
}

export const formatMessageDate = (timestamp: number, lang: string = "en"): string => {
	const now = Date.now()
	const diff = now - timestamp
	const seconds = Math.floor(diff / 1000)

	if (seconds <= 0) {
		return "now"
	} else if (seconds < 60) {
		return `${seconds} seconds ago`
	} else if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60)

		return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
	} else if (seconds < 86400 / 2) {
		const hours = Math.floor(seconds / 3600)

		return `${hours} hour${hours > 1 ? "s" : ""} ago`
	} else if (seconds < 86400) {
		const date = new Date(timestamp)

		return `Today at ${formatTime(date)}`
	} else if (seconds > 86400 && seconds < 86400 * 2) {
		const date = new Date(timestamp)

		return `Yesterday at ${formatTime(date)}`
	} else {
		const date = new Date(timestamp)

		return `${formatDate(date)} ${formatTime(date)}`
	}
}

export const isTimestampSameDay = (timestamp1: number, timestamp2: number) => {
	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)

	return date1.getFullYear() === date2.getFullYear() && date1.getMonth() === date2.getMonth() && date1.getDate() === date2.getDate()
}

export const isTimestampSameMinute = (timestamp1: number, timestamp2: number) => {
	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)
	const date1Year = date1.getFullYear()
	const date1Month = date1.getMonth()
	const date1Date = date1.getDate()
	const date1Minutes = date1.getMinutes()
	const date2Year = date2.getFullYear()
	const date2Month = date2.getMonth()
	const date2Date = date2.getDate()
	const date2Minutes = date2.getMinutes()

	return (
		date1Year === date2Year &&
		date1Month === date2Month &&
		date1Date === date2Date &&
		(date1Minutes === date2Minutes ||
			date1Minutes - 1 === date2Minutes ||
			date1Minutes === date2Minutes - 1 ||
			date1Minutes + 1 === date2Minutes ||
			date1Minutes === date2Minutes + 1 ||
			date1Minutes - 2 === date2Minutes ||
			date1Minutes === date2Minutes - 2 ||
			date1Minutes + 2 === date2Minutes ||
			date1Minutes === date2Minutes + 2)
	)
}

export interface FetchChatConversationsResult {
	cache: boolean
	conversations: ChatConversation[]
}

export const fetchChatConversations = async (skipCache: boolean = false): Promise<FetchChatConversationsResult> => {
	const refresh = async (): Promise<FetchChatConversationsResult> => {
		const conversationsDecrypted: ChatConversation[] = []
		const [result, privateKey, userId] = await Promise.all([chatConversations(), db.get("privateKey"), db.get("userId")])
		const promises: Promise<void>[] = []

		for (const conversation of result) {
			promises.push(
				new Promise(async (resolve, reject) => {
					try {
						const metadata = conversation.participants.filter(p => p.userId === userId)

						if (metadata.length !== 1) {
							resolve()

							return
						}

						const nameDecrypted =
							typeof conversation.name === "string" && conversation.name.length > 0
								? await decryptChatConversationName(conversation.name, metadata[0].metadata, privateKey)
								: ""
						const messageDecrypted =
							typeof conversation.lastMessage === "string" && conversation.lastMessage.length > 0
								? await decryptChatMessage(conversation.lastMessage, metadata[0].metadata, privateKey)
								: ""

						conversationsDecrypted.push({
							...conversation,
							name: nameDecrypted,
							lastMessage: messageDecrypted
						})
					} catch (e) {
						reject(e)

						return
					}

					resolve()
				})
			)
		}

		await Promise.all(promises)
		await db.set("chatConversations", conversationsDecrypted, "chats")

		cleanupLocalDb(conversationsDecrypted).catch(console.error)

		return {
			conversations: conversationsDecrypted,
			cache: false
		}
	}

	if (skipCache) {
		return await refresh()
	}

	const cache = await db.get("chatConversations", "chats")

	if (cache) {
		return {
			cache: true,
			conversations: cache
		}
	}

	return await refresh()
}

export interface FetchChatMessagesResult {
	cache: boolean
	messages: ChatMessage[]
}

export const fetchChatMessages = async (
	conversationUUID: string,
	metadata: string,
	timestamp: number = Date.now() + 3600000,
	skipCache: boolean = false,
	saveToLocalDb: boolean = true
): Promise<FetchChatMessagesResult> => {
	const refresh = async (): Promise<FetchChatMessagesResult> => {
		const messagesDecrypted: ChatMessage[] = []
		const [result, privateKey] = await Promise.all([chatMessages(conversationUUID, timestamp), db.get("privateKey")])
		const promises: Promise<void>[] = []

		for (const message of result) {
			promises.push(
				new Promise(async (resolve, reject) => {
					try {
						const messageDecrypted = await decryptChatMessage(message.message, metadata, privateKey)
						const replyToMessageDecrypted =
							message.replyTo.uuid.length > 0 && message.replyTo.message.length > 0
								? await decryptChatMessage(message.replyTo.message, metadata, privateKey)
								: ""

						if (messageDecrypted.length === 0) {
							resolve()

							return
						}

						messagesDecrypted.push({
							...message,
							message: messageDecrypted,
							replyTo: {
								...message.replyTo,
								message: replyToMessageDecrypted
							}
						})
					} catch (e) {
						reject(e)

						return
					}

					resolve()
				})
			)
		}

		await Promise.all(promises)

		if (saveToLocalDb) {
			await db.set("chatMessages:" + conversationUUID, messagesDecrypted.slice(-100), "chats")
		}

		return {
			messages: messagesDecrypted,
			cache: false
		}
	}

	if (skipCache) {
		return await refresh()
	}

	const cache = await db.get("chatMessages:" + conversationUUID, "chats")

	if (cache) {
		return {
			cache: true,
			messages: cache
		}
	}

	return await refresh()
}

export const parseYouTubeVideoId = (url: string): string | null => {
	const regExp = /(?:\?v=|\/embed\/|\/watch\?v=|\/\w+\/\w+\/|youtu.be\/)([\w-]{11})/
	const match = url.match(regExp)

	if (match && match.length === 2) {
		return match[1]
	}

	return null
}

export const parseFilenPublicLink = (url: string) => {
	const ex = url.split("/")
	const uuid = ex.map(part => part.split("#")[0].trim()).filter(part => validate(part))
	const keyEx = url.split("#")

	return {
		uuid: uuid.length > 0 ? uuid[0] : "",
		key: url.indexOf("#") !== -1 ? keyEx[1].trim() : ""
	}
}

export const extractLinksFromString = (input: string): string[] => {
	const urlRegex =
		/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi

	const matches = input.match(urlRegex)

	return matches || []
}

export const isMessageLink = (message: string) => {
	if (message.split(" ").length >= 2 || message.split("\n").length >= 2) {
		return false
	}

	const trimmed = message.trim()

	if (trimmed.indexOf("/localhost:") !== -1 && trimmed.startsWith("http://localhost:")) {
		return true
	}

	const urlRegex =
		/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi

	return urlRegex.test(trimmed)
}

export const getMessageDisplayType = (message: string): MessageDisplayType => {
	const isLink = isMessageLink(message)

	if (!isLink) {
		return "none"
	}

	if (
		message.indexOf("/youtube.com/watch") !== -1 ||
		message.indexOf("/youtube.com/embed") !== -1 ||
		message.indexOf("/www.youtube.com/watch") !== -1 ||
		message.indexOf("/www.youtube.com/embed") !== -1 ||
		message.indexOf("/youtu.be/") !== -1 ||
		message.indexOf("/www.youtu.be/") !== -1
	) {
		return "youtubeEmbed"
	} else if (
		(message.indexOf("/localhost:") !== -1 ||
			message.indexOf("/filen.io/") !== -1 ||
			message.indexOf("/drive.filen.io/") !== -1 ||
			message.indexOf("/drive.filen.dev/") !== -1 ||
			message.indexOf("/www.filen.io/") !== -1) &&
		message.indexOf("/d/") !== -1
	) {
		return "filenEmbed"
	} else if (
		(message.indexOf("/www.twitter.com/") !== -1 || message.indexOf("/twitter.com/") !== -1) &&
		message.indexOf("/status/") !== -1
	) {
		return "twitterEmbed"
	}

	return "async"
}

// dirty because emoji-mart's Emoji component does not support react yet
export const EmojiElement = memo(
	(props: { shortcodes?: string; native?: string; fallback?: string; size: string; style?: React.CSSProperties }) => {
		const ref = useRef<HTMLSpanElement>(null)
		const instance = useRef<any>(null)

		if (instance.current) {
			instance.current.update(props)
		}

		useEffect(() => {
			instance.current = new Emoji({ ...props, ref })

			return () => {
				instance.current = null
			}
		}, [])

		return createElement("span", {
			ref,
			style: props.style
		})
	}
)

export const ReplaceMessageWithComponents = memo(
	({
		content,
		darkMode,
		participants,
		failed
	}: {
		content: string
		darkMode: boolean
		participants: ChatConversationParticipant[]
		failed: boolean
	}) => {
		const lineBreakRegex = /\n/
		const codeRegex = /```([\s\S]*?)```/
		const linkRegex = /(https?:\/\/\S+)/
		const emojiRegexWithSkinTones = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/
		const mentions = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/
		const emojiRegex = new RegExp(`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}`)
		const regex = new RegExp(
			`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}|${codeRegex.source}|${lineBreakRegex.source}|${linkRegex.source}|${mentions.source}`
		)
		const emojiCount = content.match(emojiRegex)

		let size: number | undefined = 32

		if (emojiCount) {
			const emojiCountJoined = emojiCount.join("")

			if (emojiCountJoined.length !== content.length) {
				size = 22
			}
		}

		const replaced = regexifyString({
			pattern: regex,
			decorator: (match, index) => {
				if (match.startsWith("@") && (match.split("@").length === 3 || match.startsWith("@everyone"))) {
					const email = match.slice(1).trim()

					if (email === "everyone") {
						return (
							<Fragment key={match + ":" + index}>
								<Text
									color={failed ? getColor(darkMode, "red") : "white"}
									cursor="pointer"
									backgroundColor={getColor(darkMode, "indigo")}
									padding="1px"
									paddingLeft="3px"
									paddingRight="3px"
									borderRadius="5px"
								>
									@everyone
								</Text>
								<span>&nbsp;</span>
							</Fragment>
						)
					}

					if (email.indexOf("@") === -1) {
						return (
							<Fragment key={match + ":" + index}>
								<Text color={failed ? getColor(darkMode, "red") : getColor(darkMode, "textSecondary")}>@UnknownUser</Text>
								<span>&nbsp;</span>
							</Fragment>
						)
					}

					const foundParticipant = participants.filter(p => p.email === email)

					if (foundParticipant.length === 0) {
						return (
							<Fragment key={match + ":" + index}>
								<Text color={failed ? getColor(darkMode, "red") : getColor(darkMode, "textSecondary")}>@UnknownUser</Text>
								<span>&nbsp;</span>
							</Fragment>
						)
					}

					return (
						<Fragment key={match + ":" + index}>
							<Text
								color={failed ? getColor(darkMode, "red") : "white"}
								cursor="pointer"
								onClick={() => eventListener.emit("openUserProfileModal", foundParticipant[0].userId)}
								backgroundColor={getColor(darkMode, "indigo")}
								padding="1px"
								paddingLeft="3px"
								paddingRight="3px"
								borderRadius="5px"
							>
								@{getUserNameFromParticipant(foundParticipant[0])}
							</Text>
							<span>&nbsp;</span>
						</Fragment>
					)
				}

				if (match.split("```").length >= 3) {
					const code = match.split("```").join("")

					return (
						<Fragment key={match + ":" + index}>
							<Flex
								paddingTop="5px"
								paddingBottom="5px"
								flexDirection="column"
							>
								<pre
									style={{
										maxWidth: "100%",
										whiteSpace: "pre-wrap",
										overflow: "hidden",
										margin: "0px",
										textIndent: 0,
										backgroundColor: getColor(darkMode, "backgroundTertiary"),
										borderRadius: "5px",
										paddingLeft: "10px",
										paddingRight: "10px",
										paddingBottom: "10px",
										paddingTop: "10px",
										fontWeight: "bold",
										color: failed ? getColor(darkMode, "red") : getColor(darkMode, "textSecondary"),
										border: "1px solid " + getColor(darkMode, "borderPrimary")
									}}
								>
									<code
										style={{
											maxWidth: "100%",
											whiteSpace: "pre-wrap",
											overflow: "hidden",
											margin: "0px"
										}}
									>
										{code.startsWith("\n") ? code.slice(1, code.length) : code}
									</code>
								</pre>
							</Flex>
							<Flex
								height="5px"
								width="100%"
								flexBasis="100%"
							/>
						</Fragment>
					)
				}

				if (linkRegex.test(match) && (match.startsWith("https://") || match.startsWith("http://"))) {
					return (
						<Link
							key={match + ":" + index}
							color={failed ? getColor(darkMode, "red") : getColor(darkMode, "linkPrimary")}
							cursor="pointer"
							href={match}
							target="_blank"
							rel="noreferrer"
							_hover={{
								textDecoration: "underline"
							}}
							className="user-select-text"
							userSelect="text"
							onContextMenu={e => e.stopPropagation()}
						>
							{match}
						</Link>
					)
				}

				if (match.indexOf("\n") !== -1) {
					return (
						<Flex
							key={match + ":" + index}
							height="5px"
							width="100%"
							flexBasis="100%"
						/>
					)
				}

				if (customEmojisList.includes(match.split(":").join("").trim())) {
					return (
						<Flex
							key={match + ":" + index}
							title={match.indexOf(":") !== -1 ? match : undefined}
							width={size ? size + 6 + "px" : undefined}
							height={size ? size + "px" : undefined}
							alignItems="center"
							justifyContent="center"
						>
							<EmojiElement
								fallback={match}
								shortcodes={match.indexOf(":") !== -1 ? match : undefined}
								size={size ? size + "px" : "34px"}
								style={{
									width: size ? size + "px" : undefined,
									height: size ? size + "px" : undefined,
									display: "inline-block"
								}}
							/>
						</Flex>
					)
				}

				return (
					<Flex
						key={match + ":" + index}
						title={match.indexOf(":") !== -1 ? match : undefined}
						width={size ? size + 6 + "px" : undefined}
						height={size ? size + "px" : undefined}
						alignItems="center"
						justifyContent="center"
					>
						<EmojiElement
							fallback={match}
							shortcodes={match.indexOf(":") !== -1 ? match : undefined}
							native={match.indexOf(":") === -1 ? match : undefined}
							size={size ? size + "px" : "34px"}
							style={{
								display: "inline-block"
							}}
						/>
					</Flex>
				)
			},
			input: content
		})

		return <>{replaced}</>
	}
)

export const ReplaceInlineMessageWithComponents = memo(
	({
		content,
		darkMode,
		emojiSize,
		hideLinks,
		hideMentions,
		participants
	}: {
		content: string
		darkMode: boolean
		emojiSize?: number
		hideLinks?: boolean
		hideMentions?: boolean
		participants: ChatConversationParticipant[]
	}) => {
		const codeRegex = /```([\s\S]*?)```/
		const linkRegex = /(https?:\/\/\S+)/
		const emojiRegexWithSkinTones = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/
		const mentions = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/
		const regex = new RegExp(
			`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}|${codeRegex.source}|${linkRegex.source}|${mentions.source}`
		)
		const size = emojiSize ? emojiSize : 16

		const replaced = regexifyString({
			pattern: regex,
			decorator: (match, index) => {
				if (match.startsWith("@") && (match.split("@").length === 3 || match.startsWith("@everyone"))) {
					const email = match.slice(1).trim()

					if (email === "everyone") {
						return (
							<Fragment key={match + ":" + index}>
								<Text color={getColor(darkMode, "textSecondary")}>@everyone</Text>
							</Fragment>
						)
					}

					const foundParticipant = participants.filter(p => p.email === email)

					if (foundParticipant.length === 0) {
						return (
							<Fragment key={match + ":" + index}>
								<Text color={getColor(darkMode, "textSecondary")}>@UnknownUser</Text>
							</Fragment>
						)
					}

					if (hideMentions) {
						return (
							<Fragment key={match + ":" + index}>
								<Text color={getColor(darkMode, "textSecondary")}>@{getUserNameFromParticipant(foundParticipant[0])}</Text>
							</Fragment>
						)
					}

					return (
						<Fragment key={match + ":" + index}>
							<Text
								color={getColor(darkMode, "textPrimary")}
								_hover={{
									textDecoration: "underline"
								}}
								cursor="pointer"
								onClick={() => eventListener.emit("openUserProfileModal", foundParticipant[0].userId)}
							>
								@{getUserNameFromParticipant(foundParticipant[0])}
							</Text>
						</Fragment>
					)
				}

				if (linkRegex.test(match) && (match.startsWith("https://") || match.startsWith("http://"))) {
					if (hideLinks) {
						return <Fragment key={match + ":" + index}>{match}</Fragment>
					}

					return (
						<Link
							key={match + ":" + index}
							color={getColor(darkMode, "linkPrimary")}
							cursor="pointer"
							href={match}
							target="_blank"
							rel="noreferrer"
							_hover={{
								textDecoration: "underline"
							}}
							className="user-select-text"
							userSelect="text"
							onContextMenu={e => e.stopPropagation()}
						>
							{match}
						</Link>
					)
				}

				if (customEmojisList.includes(match.split(":").join("").trim())) {
					return (
						<Flex
							key={match + ":" + index}
							title={match.indexOf(":") !== -1 ? match : undefined}
							width={size ? size + 2 + "px" : undefined}
							height={size ? size + "px" : undefined}
							alignItems="center"
							justifyContent="center"
						>
							<EmojiElement
								fallback={match}
								shortcodes={match.indexOf(":") !== -1 ? match : undefined}
								size={size ? size + "px" : "34px"}
								style={{
									width: size ? size + "px" : undefined,
									height: size ? size + "px" : undefined,
									display: "inline-block"
								}}
							/>
						</Flex>
					)
				}

				return (
					<Flex
						key={match + ":" + index}
						title={match.indexOf(":") !== -1 ? match : undefined}
						width={size ? size + 2 + "px" : undefined}
						height={size ? size + "px" : undefined}
						alignItems="center"
						justifyContent="center"
					>
						<EmojiElement
							fallback={match}
							shortcodes={match.indexOf(":") !== -1 ? match : undefined}
							native={match.indexOf(":") === -1 ? match : undefined}
							size={size ? size + "px" : "34px"}
							style={{
								display: "inline-block"
							}}
						/>
					</Flex>
				)
			},
			input: content.split("\n").join(" ").split("`").join("")
		})

		return <>{replaced}</>
	}
)

export const parseTwitterStatusIdFromURL = (url: string) => {
	const ex = url.split("/")

	return ex[ex.length - 1].trim()
}

export const cleanupLocalDb = async (conversations: ChatConversation[]) => {
	const keys = await db.keys("chats")

	const existingConversationsUUIDs: string[] = conversations.map(c => c.uuid)

	for (const key of keys) {
		if (key.startsWith("chatMessages:")) {
			const noteUUID = key.split(":")[1]

			if (!existingConversationsUUIDs.includes(noteUUID)) {
				await db.remove(key, "chats")
			}
		}
	}

	const chatsLastFocusTimestamp: Record<string, number> = JSON.parse(window.localStorage.getItem("chatsLastFocusTimestamp") || "{}")

	for (const key in chatsLastFocusTimestamp) {
		if (!existingConversationsUUIDs.includes(key)) {
			window.localStorage.setItem(
				"chatsLastFocusTimestamp",
				JSON.stringify(
					Object.keys(chatsLastFocusTimestamp)
						.filter(k => k !== key)
						.reduce((current, k) => Object.assign(current, { [k]: chatsLastFocusTimestamp[k] }), {})
				)
			)
		}
	}
}

export const sortAndFilterConversations = (conversations: ChatConversation[], search: string, userId: number) => {
	return conversations
		.filter(convo => convo.participants.length >= 1 && (convo.lastMessageTimestamp > 0 || userId === convo.ownerId))
		.filter(convo => {
			if (search.length === 0) {
				return true
			}

			if (
				convo.participants
					.map(p => getUserNameFromParticipant(p))
					.join(", ")
					.toLowerCase()
					.trim()
					.indexOf(search.toLowerCase().trim()) !== -1
			) {
				return true
			}

			if (convo.lastMessage?.toLowerCase().trim().indexOf(search.toLowerCase().trim()) !== -1) {
				return true
			}

			return false
		})
		.sort((a, b) => {
			if (a.lastMessageTimestamp > 0 && b.lastMessageTimestamp > 0) {
				return b.lastMessageTimestamp - a.lastMessageTimestamp
			} else if (a.lastMessageTimestamp === 0 && b.lastMessageTimestamp === 0) {
				return b.createdTimestamp - a.createdTimestamp
			} else {
				return b.lastMessageTimestamp - a.lastMessageTimestamp
			}
		})
}
