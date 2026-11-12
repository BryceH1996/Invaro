; Included by electron-builder's NSIS installer (package.json build.nsis.include).

; Uninstalling Invoicer removes its reminder task from Windows Task Scheduler.
; Updates also run the old version's uninstaller, so they're skipped here; the new
; version keeps the task in step with your clients when it starts.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /delete /tn "Invoicer reminders" /f'
  ${endIf}
!macroend
