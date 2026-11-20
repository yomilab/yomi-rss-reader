import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsPane } from './settingsControls';
import { ShortcutsPane } from './panes/ShortcutsPane';
import './SettingsWindow.css';

// Settings → Shortcuts on its own; the pane reads only static shortcut labels.
const ShortcutsSettingsFrame = () => (
  // Same default size as the `settings` window in tauri.conf.json (700×660).
  <div style={{ width: 700, height: 660, overflow: 'auto', position: 'relative' }}>
    <div className="settings-window">
      <div className="settings-window-content">
        <main className="settings-main">
          <SettingsPane title="Shortcuts" subtitle="Keyboard shortcuts for common actions.">
            <ShortcutsPane />
          </SettingsPane>
        </main>
      </div>
    </div>
  </div>
);

const meta = {
  title: 'Theme Debug/Settings Shortcuts',
  component: ShortcutsSettingsFrame,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ShortcutsSettingsFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Article group starts with Open Article (→ or Enter). */
export const Shortcuts: Story = {};
