import { ActionSectionRows, InteractiveActionSection } from "../../types/types";
import { MAIN_MENU_REPLY_IDS } from "../../constants/whatsapp";

export const MainMenuRows: ActionSectionRows[] = [
  {
    id: MAIN_MENU_REPLY_IDS.shop,
    title: "Start Shopping",
    description: "Choose your shopping category and browse our products",
  },
  {
    id: MAIN_MENU_REPLY_IDS.view_deliveries,
    title: "View My Deliveries",
    description: "Track your deliveries in real-time",
  },
  {
    id: MAIN_MENU_REPLY_IDS.enquries,
    title: "Contact Support",
    description: "Get help with your orders or ask any questions",
  }
];

export const MainMenuSections: InteractiveActionSection[] = [
  {
    title: "Main Menu",
    rows: MainMenuRows,
  },
];
