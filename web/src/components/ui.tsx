import type { ComponentChildren, JSX } from 'preact';

export function Field(props: { label: string; value: string; onInput: (v: string) => void; type?: string; hint?: string; autoComplete?: string; name?: string; autoFocus?: boolean; disabled?: boolean }) {
  const id = `f-${props.name ?? props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      <input id={id} name={props.name} type={props.type ?? 'text'} value={props.value} autoComplete={props.autoComplete}
        autoFocus={props.autoFocus} disabled={props.disabled} spellcheck={false} autocapitalize="none"
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)} aria-describedby={props.hint ? `${id}-hint` : undefined} />
      {props.hint && <small id={`${id}-hint`}>{props.hint}</small>}
    </div>
  );
}
export function PrimaryButton(props: { children: ComponentChildren; busy?: boolean; disabled?: boolean; type?: 'submit' | 'button'; onClick?: () => void } & Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'>) {
  const { children, busy, disabled, type, ...rest } = props;
  return <button {...rest} class="btn primary" type={type ?? 'submit'} disabled={disabled || busy} aria-busy={busy}>{busy && <span class="spinner" aria-hidden="true" />}{children}</button>;
}
export function TextButton(props: { children: ComponentChildren; onClick: () => void }) {
  return <button class="btn text" type="button" onClick={props.onClick}>{props.children}</button>;
}
export function ErrorLine({ message }: { message?: string | null }) {
  return message ? <p class="error" role="alert">{message}</p> : null;
}
