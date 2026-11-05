; The preparation step verifies Microsoft's signatures and the x64 architecture.
; Missing preparation is a compile error, not an installer that borrows the build PC's CRT.
!define WING_CRT_DIR "${__FILEDIR__}\runtime\x64"

!macro WING_INSTALL_CRT DIRECTORY
  SetOutPath "${DIRECTORY}"
  File "${WING_CRT_DIR}\concrt140.dll"
  File "${WING_CRT_DIR}\msvcp140.dll"
  File "${WING_CRT_DIR}\msvcp140_1.dll"
  File "${WING_CRT_DIR}\msvcp140_2.dll"
  File "${WING_CRT_DIR}\msvcp140_atomic_wait.dll"
  File "${WING_CRT_DIR}\msvcp140_codecvt_ids.dll"
  File "${WING_CRT_DIR}\vccorlib140.dll"
  File "${WING_CRT_DIR}\vcruntime140.dll"
  File "${WING_CRT_DIR}\vcruntime140_1.dll"
  File "${WING_CRT_DIR}\vcruntime140_threads.dll"
!macroend

!macro WING_REMOVE_CRT DIRECTORY
  Delete "${DIRECTORY}\concrt140.dll"
  Delete "${DIRECTORY}\msvcp140.dll"
  Delete "${DIRECTORY}\msvcp140_1.dll"
  Delete "${DIRECTORY}\msvcp140_2.dll"
  Delete "${DIRECTORY}\msvcp140_atomic_wait.dll"
  Delete "${DIRECTORY}\msvcp140_codecvt_ids.dll"
  Delete "${DIRECTORY}\vccorlib140.dll"
  Delete "${DIRECTORY}\vcruntime140.dll"
  Delete "${DIRECTORY}\vcruntime140_1.dll"
  Delete "${DIRECTORY}\vcruntime140_threads.dll"
!macroend
