import { CONFIG } from "../../config"

const welcomeMessage = 
`*Hi! Welcome to ${CONFIG.SHOP_NAME}.* 👋

Why carry heavy bags when we can do it for you? Get your daily essentials delivered straight to your doorstep! 🏠🚚

*The Benefits:*
✅ Save Time.
✅ No queues.
✅ No traffic.

📍 *Find us at:* ${CONFIG.SHOP_ADDRESS}

Tap *'Start Shopping'* below to browse our aisles from your couch! 🛋️
`

export const MESSAGES_CONSTRUCTOR = {
    welcomeMessage,
}