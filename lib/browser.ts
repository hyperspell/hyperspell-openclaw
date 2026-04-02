import { execFile } from "node:child_process"
import { platform } from "node:os"

export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let file: string
    let args: string[]

    switch (platform()) {
      case "darwin":
        file = "open"
        args = [url]
        break
      case "win32":
        file = "cmd"
        args = ["/c", "start", "", url]
        break
      default:
        file = "xdg-open"
        args = [url]
    }

    execFile(file, args, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
