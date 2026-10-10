import { Link } from "react-router-dom";
import { Camera, Database, Gear, Utensils } from "../icons";
import { usePhotos, useStatus } from "../api";

export function MorePage() {
  const { data: status } = useStatus();
  const { data: photos } = usePhotos();
  const waiting = photos?.photos.filter((p) => p.status === "waiting").length ?? 0;
  const items = [
    { to: "/photos", icon: <Camera />, title: "Saved photos", text: waiting ? `${waiting} waiting to be turned into recipes` : "Photos of recipes to read now or later" },
    { to: "/new", icon: <Utensils />, title: "Write a recipe", text: "Type one in yourself" },
    { to: "/nutrition", icon: <Database />, title: "Nutrition data", text: "Every food's calories and nutrients — view and fix them" },
    { to: "/settings", icon: <Gear />, title: "Settings", text: "People, meals, AI models, version history" },
  ];
  return (
    <>
      <div className="page-head">
        <h1>More</h1>
      </div>
      <div className="stack">
        {items.map((i) => (
          <Link key={i.to} to={i.to} className="card row" style={{ color: "inherit", textDecoration: "none" }}>
            <span style={{ width: 28, color: "var(--primary)" }}>{i.icon}</span>
            <div className="grow">
              <div style={{ fontWeight: 800 }}>{i.title}</div>
              <div className="small muted">{i.text}</div>
            </div>
          </Link>
        ))}
      </div>
      {status && (
        <p className="small muted center">
          {status.recipes} recipes · data in <code>{status.dataDir}</code>
        </p>
      )}
    </>
  );
}
