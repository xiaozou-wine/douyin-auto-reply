export const DOUYIN_MESSAGES_URL = 'https://www.douyin.com/user/self?showTab=message';

export const selectors = {
  conversationListItems: [
    '[data-e2e*="conversation"]',
    '[class*="conversation"]',
    '[class*="Conversation"]',
    '[class*="chat"] li',
    'li:has-text("")',
  ],
  unreadBadge: [
    '[class*="unread"]',
    '[class*="badge"]',
    'text=/^[1-9][0-9]*$/',
  ],
  messageInput: [
    'div[contenteditable="true"]',
    'textarea',
  ],
  attachmentButton: [
    'button:has-text("图片")',
    'button:has-text("文件")',
    '[aria-label*="图片"]',
    '[aria-label*="上传"]',
  ],
  fileInput: 'input[type="file"]',
  sendButton: [
    'button:has-text("发送")',
    '[aria-label*="发送"]',
  ],
  outgoingMessage: [
    '[class*="message"]:has(img)',
    '[class*="Message"]:has(img)',
  ],
} as const;
