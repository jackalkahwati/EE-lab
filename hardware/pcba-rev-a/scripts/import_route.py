"""Import the freerouting SES session into the routed board, refill zones,
and report connectivity. Run with KiCad's bundled python."""
import pcbnew

BOARD = "elec/layout/rev-a-routed.kicad_pcb"
SES = "/tmp/reva2.ses"

b = pcbnew.LoadBoard(BOARD)
ok = pcbnew.ImportSpecctraSES(b, SES)
print("SES import:", ok)

filler = pcbnew.ZONE_FILLER(b)
filler.Fill(b.Zones())
pcbnew.SaveBoard(BOARD, b)

# connectivity report
conn = b.GetConnectivity()
unrouted = conn.GetUnconnectedCount(True)
print("tracks:", len(b.GetTracks()))
print("unrouted connections remaining:", unrouted)
