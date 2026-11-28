import AppKit
import Foundation
let args = CommandLine.arguments
func output(_ object: Any) { if let d = try? JSONSerialization.data(withJSONObject: object), let s = String(data:d,encoding:.utf8) { print(s) } }
guard args.count >= 3 else { exit(2) }
let action=args[1], file=URL(fileURLWithPath:args[2])
let ws=NSWorkspace.shared
if action == "info" {
 let current=ws.urlForApplication(toOpen:file)?.path
 let apps=ws.urlsForApplications(toOpen:file).map { u -> [String:Any] in
  let bundle=Bundle(url:u)
  return ["path":u.path,"name":(bundle?.object(forInfoDictionaryKey:"CFBundleDisplayName") as? String) ?? (bundle?.object(forInfoDictionaryKey:"CFBundleName") as? String) ?? u.deletingPathExtension().lastPathComponent,"isDefault":u.path == current]
 }
 output(["apps":apps]); exit(0)
}
if action == "reveal" { ws.activateFileViewerSelecting([file]); output(["ok":true]); exit(0) }
if action == "open" {
 if args.count == 3 { output(["ok":ws.open(file)]); exit(0) }
 let app=URL(fileURLWithPath:args[3])
 guard ws.urlsForApplications(toOpen:file).contains(where:{$0.standardizedFileURL == app.standardizedFileURL}) else { output(["ok":false,"error":"应用不在此文件的系统关联列表中"]);exit(1) }
 let config=NSWorkspace.OpenConfiguration()
 ws.open([file],withApplicationAt:app,configuration:config) { _,error in
  output(["ok":error == nil,"error":error?.localizedDescription ?? ""]);exit(error == nil ? 0:1)
 }
 RunLoop.main.run()
}
