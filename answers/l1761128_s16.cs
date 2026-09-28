using System;

class Program
{
    static void Main()
    {
        string name = Console.ReadLine();
        string result = char.ToUpper(name[0]) + name.Substring(1);
        Console.WriteLine(result);
    }
}