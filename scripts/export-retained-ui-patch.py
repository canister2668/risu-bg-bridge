"""Export only the opt-in renderer changes and their regression fixtures."""
import difflib,subprocess,sys
from pathlib import Path
source=Path(sys.argv[1]).resolve()
tracked=['src/lib/ChatScreens/Chat.svelte','src/lib/ChatScreens/ChatBody.svelte']
new=['src/lib/ChatScreens/UiContinuityHarness.svelte','src/lib/ChatScreens/uiContinuity.test.ts']
patch=subprocess.check_output(['git','-C',str(source),'diff','--',*tracked],text=True)
assert patch and '[UI_CONTINUITY_V1]' in patch
for name in new:
    patch+='diff --git a/'+name+' b/'+name+'\nnew file mode 100644\n'
    patch+=''.join(difflib.unified_diff([], (source/name).read_text().splitlines(keepends=True),fromfile='/dev/null',tofile='b/'+name))
target=Path(__file__).resolve().parents[1]/'adapters/ui/haejeok/retained-ui-b6732.patch'
target.write_text(patch)
print(target)
