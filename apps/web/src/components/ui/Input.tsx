import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const control =
  "w-full rounded-lg border bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-200 disabled:bg-slate-50 disabled:text-slate-500";

interface FieldProps {
  label?: string;
  error?: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}

export function Field({ label, error, hint, children, className = "" }: FieldProps) {
  const id = useId();
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      {children(id)}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>
      )}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
  leading?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, wrapperClassName, leading, className = "", ...rest },
  ref,
) {
  return (
    <Field label={label} error={error} hint={hint} className={wrapperClassName}>
      {(id) => (
        <div className="relative">
          {leading && <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-slate-400">{leading}</span>}
          <input
            id={id}
            ref={ref}
            aria-invalid={!!error}
            {...rest}
            className={`${control} h-10 ${error ? "border-red-400" : "border-slate-300"} ${leading ? "pl-10" : ""} ${className}`}
          />
        </div>
      )}
    </Field>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  wrapperClassName?: string;
}

export function Select({ label, error, wrapperClassName, className = "", children, ...rest }: SelectProps) {
  return (
    <Field label={label} error={error} className={wrapperClassName}>
      {(id) => (
        <select id={id} {...rest} className={`${control} h-10 ${error ? "border-red-400" : "border-slate-300"} ${className}`}>
          {children}
        </select>
      )}
    </Field>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className = "", ...rest }: TextareaProps) {
  return (
    <Field label={label} error={error}>
      {(id) => <textarea id={id} rows={3} {...rest} className={`${control} py-2 ${error ? "border-red-400" : "border-slate-300"} ${className}`} />}
    </Field>
  );
}

export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" {...rest} className="mt-0.5 size-4 rounded border-slate-300 accent-navy-900" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}
