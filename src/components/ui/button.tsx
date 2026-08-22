import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
  { variants: {
      variant: {
        default: "bg-pink-600 px-4 py-2 text-white hover:bg-pink-500",
        secondary: "border border-white/10 bg-white/5 px-4 py-2 text-slate-100 hover:bg-white/10",
        ghost: "px-3 py-2 text-slate-300 hover:bg-white/5 hover:text-white",
        destructive: "bg-red-500/15 px-4 py-2 text-red-300 hover:bg-red-500/25",
      },
      size: { default: "h-10", sm: "h-8 text-xs", icon: "size-9 p-0" },
    }, defaultVariants: { variant: "default", size: "default" },
  },
);
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";
