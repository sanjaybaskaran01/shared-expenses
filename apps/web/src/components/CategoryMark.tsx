import ArrowRightLeft from "lucide-solid/icons/arrow-right-left";
import BedSingle from "lucide-solid/icons/bed-single";
import CarFront from "lucide-solid/icons/car-front";
import Fuel from "lucide-solid/icons/fuel";
import Gamepad2 from "lucide-solid/icons/gamepad-2";
import Gift from "lucide-solid/icons/gift";
import GraduationCap from "lucide-solid/icons/graduation-cap";
import HeartPulse from "lucide-solid/icons/heart-pulse";
import House from "lucide-solid/icons/house";
import Lightbulb from "lucide-solid/icons/lightbulb";
import Package from "lucide-solid/icons/package";
import PawPrint from "lucide-solid/icons/paw-print";
import Plane from "lucide-solid/icons/plane";
import ReceiptText from "lucide-solid/icons/receipt-text";
import ShoppingBasket from "lucide-solid/icons/shopping-basket";
import Ticket from "lucide-solid/icons/ticket";
import Utensils from "lucide-solid/icons/utensils";
import Wine from "lucide-solid/icons/wine";
import { expenseCategoryTone } from "../lib/expense-categories";

export function CategoryMark(props: { category: string; compact?: boolean; class?: string }) {
  const Icon = () => {
    switch (props.category) {
      case "Dining out": return Utensils;
      case "Groceries": return ShoppingBasket;
      case "Liquor": return Wine;
      case "Rent": return House;
      case "Household supplies": return Package;
      case "Utilities": return Lightbulb;
      case "Transportation":
      case "Taxi": return CarFront;
      case "Gas/fuel": return Fuel;
      case "Plane": return Plane;
      case "Hotel": return BedSingle;
      case "Entertainment": return Ticket;
      case "Games": return Gamepad2;
      case "Medical expenses": return HeartPulse;
      case "Gifts": return Gift;
      case "Education": return GraduationCap;
      case "Pets": return PawPrint;
      case "Payment": return ArrowRightLeft;
      default: return ReceiptText;
    }
  };
  const MarkIcon = Icon();
  return (
    <span
      class={`category-icon category-tone-${expenseCategoryTone(props.category)}${props.compact ? " category-icon-compact" : ""}${props.class ? ` ${props.class}` : ""}`}
      aria-hidden="true"
    >
      <MarkIcon size={props.compact ? 15 : 17} stroke-width={2} />
    </span>
  );
}
