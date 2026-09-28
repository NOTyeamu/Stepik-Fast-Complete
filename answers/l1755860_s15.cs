using System;

class Program
{
    static void Main()
    {
        string filename = Console.ReadLine();
        string result = filename.EndsWith(".jpg") || filename.EndsWith(".png") || filename.EndsWith(".gif") ? "Image" : "Other";  
        Console.WriteLine(result);
    }
}